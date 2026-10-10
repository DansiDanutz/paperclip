import { describe, expect, it } from "vitest";
import { SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION } from "../src/constants.js";
import { buildApprovalMessage, parseSlackEnvelope, parseThreadReply } from "../src/slack.js";
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
});
