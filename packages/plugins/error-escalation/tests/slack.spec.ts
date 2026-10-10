import { describe, expect, it } from "vitest";
import { SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION } from "../src/constants.js";
import { buildApprovalMessage, parseSlackEnvelope, parseThreadReply, postEscalationMessage, socketHealth, startSlackSocket, type SlackSocketLike } from "../src/slack.js";
import type { EscalationRecord } from "../src/state.js";

function record(): EscalationRecord {
  return {
    id: "esc-1",
    companyId: "co",
    issueId: "issue-1",
    failedRunId: "run-1",
    failedAgentId: "agent-1",
    failedAdapterType: "claude_local",
    error: "boom",
    errorCode: "adapter_failed",
    stdoutExcerpt: null,
    stderrExcerpt: "nope",
    repoUrl: "https://github.com/example/repo",
    repoRef: "main",
    branchName: "fix",
    cwd: "/tmp/repo",
    baselinePorcelain: "",
    candidates: ["codex_local", "grok_build"],
    proposals: [],
    judge: { model: "openrouter/free", decision: "Use Codex", reason: "Smaller" },
    status: "awaiting_approval",
    slack: { channel: "C-FLEET", ts: "111.222" },
    decision: null,
    failureNote: null,
    version: 1,
    delivery: null,
    proposalDeadlineAt: null,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
  };
}

describe("slack messages", () => {
  it("includes approve and reject buttons and says nothing will be written", () => {
    const message = buildApprovalMessage(record(), true);
    const actions = message.blocks.find((block) => block.type === "actions") as { elements: Array<{ action_id: string }> };
    expect(actions.elements.map((element) => element.action_id)).toEqual([SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION]);
    expect(message.text).toContain("Nothing will be written");
  });

  it("parses an approve button, a reject modal, and a thread reply", () => {
    expect(parseSlackEnvelope({
      payload: {
        type: "block_actions",
        trigger_id: "trig",
        user: { id: "U-DAN" },
        channel: { id: "C-FLEET" },
        message: { ts: "111.222" },
        actions: [{ action_id: SLACK_APPROVE_ACTION, value: "esc-1" }],
      },
    })).toMatchObject({ type: "approve", escalationId: "esc-1", userId: "U-DAN", channelId: "C-FLEET", messageTs: "111.222" });

    expect(parseSlackEnvelope({
      payload: {
        type: "block_actions",
        trigger_id: "trig",
        user: { id: "U-DAN" },
        channel: { id: "C-FLEET" },
        message: { ts: "111.222" },
        actions: [{ action_id: SLACK_REJECT_ACTION, value: "esc-1" }],
      },
    })).toMatchObject({ type: "open_reject_modal", triggerId: "trig" });

    expect(parseThreadReply("reject: too broad")).toEqual({ outcome: "rejected", reason: "too broad" });
    expect(parseThreadReply("approve")).toEqual({ outcome: "approved", reason: null });
  });

  it("posts approve and reject while the record is still judging, including a failed attempt", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const judging = { ...record(), status: "judging" as const, slack: null };
    const transport = {
      fetch: async (_url: string, init?: RequestInit) => {
        calls += 1;
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (calls === 1) throw new Error("slack down");
        return new Response(JSON.stringify({ ok: true, channel: "C-FLEET", ts: "333.444" }), { status: 200 });
      },
    };
    await expect(postEscalationMessage({
      transport,
      token: "xoxb-test",
      channel: "C-FLEET",
      record: judging,
    })).rejects.toThrow(/slack down/);
    const retry = { ...judging, status: "failed" as const };
    const posted = await postEscalationMessage({
      transport,
      token: "xoxb-test",
      channel: "C-FLEET",
      record: retry,
    });
    expect(posted).toEqual({ channel: "C-FLEET", ts: "333.444" });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      const blocks = body.blocks as Array<{ type?: string; elements?: Array<{ action_id?: string }> }>;
      const actions = blocks.find((block) => block.type === "actions");
      expect(actions?.elements?.map((element) => element.action_id)).toEqual([SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION]);
    }
  });

  it("omits buttons when there is no judge result", async () => {
    let body: Record<string, unknown> | null = null;
    const failed = { ...record(), judge: null, status: "failed" as const, slack: null, failureNote: "Nothing was sent to the judge." };
    await postEscalationMessage({
      transport: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ ok: true, channel: "C-FLEET", ts: "9.9" }), { status: 200 });
        },
      },
      token: "xoxb-test",
      channel: "C-FLEET",
      record: failed,
    });
    const blocks = (body?.blocks ?? []) as Array<{ type?: string }>;
    expect(blocks.some((block) => block.type === "actions")).toBe(false);
  });
});

class FakeSocket implements SlackSocketLike {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  private handlers: Record<string, Array<(data?: unknown) => void>> = {};

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  on(event: "message" | "close" | "error", cb: (data?: unknown) => void) {
    this.handlers[event] ??= [];
    this.handlers[event]!.push(cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    for (const cb of this.handlers.close ?? []) cb();
  }
}

describe("slack socket", () => {
  it("retries a failed apps.connections.open without a global WebSocket", async () => {
    FakeSocket.instances = [];
    const states: string[] = [];
    const timers: Array<() => void> = [];
    let opens = 0;
    const socket = startSlackSocket({
      appToken: "xapp-test",
      transport: {
        fetch: async () => {
          opens += 1;
          if (opens === 1) {
            return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, url: "wss://example.test/socket" }), { status: 200 });
        },
      },
      onEnvelope: async () => undefined,
      WebSocketImpl: FakeSocket,
      schedule: (_ms, fn) => {
        timers.push(fn);
        return () => undefined;
      },
      onState: (state) => {
        states.push(state);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(states).toContain("disconnected");
    expect(FakeSocket.instances).toHaveLength(0);
    expect(socketHealth("disconnected").status).toBe("degraded");
    timers.at(-1)?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]?.url).toBe("wss://example.test/socket");
    expect(states).toContain("open");
    socket.stop();
    const opensAfterStop = opens;
    timers.at(-1)?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opens).toBe(opensAfterStop);
  });
});
