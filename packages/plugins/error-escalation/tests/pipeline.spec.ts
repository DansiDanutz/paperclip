import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Company, Issue } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION, SLACK_REJECT_CALLBACK } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { resumeEscalations, setPipelineOverrides, type PipelineDeps } from "../src/pipeline.js";
import { buildApprovalMessage, postEscalationMessage } from "../src/slack.js";
import { listEscalationsForIssue, listPendingDeliveries, rememberPendingDelivery, saveEscalation, type EscalationRecord } from "../src/state.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const CLAUDE_ID = "33333333-3333-4333-8333-333333333333";
const CODEX_ID = "44444444-4444-4444-8444-444444444444";
const GROK_ID = "55555555-5555-4555-8555-555555555555";
const KIMI_ID = "66666666-6666-4666-8666-666666666666";
const APPROVER = "U_DAN";
const CHANNEL = "C-FLEET";

interface InvokeCall {
  agentId: string;
  runId: string;
  prompt: string;
  reason?: string;
  issueId?: string;
  taskKey?: string;
  escalationCwd?: string;
}

function company(): Company {
  const now = new Date("2026-10-09T00:00:00.000Z");
  return {
    id: COMPANY_ID,
    name: "Seme",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "SEM",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

function issue(): Issue {
  const now = new Date("2026-10-09T00:00:00.000Z");
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Failing task",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: CLAUDE_ID,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "SEM-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function agent(id: string, name: string): Agent {
  const now = new Date("2026-10-09T00:00:00.000Z");
  return {
    id,
    companyId: COMPANY_ID,
    name,
    urlKey: name,
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
}

function baseConfig(extra: Record<string, unknown> = {}) {
  return {
    enabled: true,
    sink: "telegram",
    slackChannelId: CHANNEL,
    slackApproverUserId: APPROVER,
    judgeModel: "openrouter/free",
    fanoutCount: 2,
    autoApply: false,
    applyOnApprove: false,
    harnessAgents: {
      claude_local: CLAUDE_ID,
      codex_local: CODEX_ID,
      grok_build: GROK_ID,
      kimi: KIMI_ID,
    },
    ...extra,
  };
}

function failurePayload(extra: Record<string, unknown> = {}) {
  return {
    runId: "run-failed",
    agentId: CLAUDE_ID,
    adapterType: "claude_local",
    status: "failed",
    error: "adapter exploded",
    errorCode: "adapter_failed",
    exitCode: 1,
    issueId: ISSUE_ID,
    stdoutExcerpt: "last stdout",
    stderrExcerpt: "last stderr",
    repoUrl: "https://github.com/DansiDanutz/paperclip",
    repoRef: "master",
    branchName: "master",
    cwd: "/tmp/seme",
    ...extra,
  };
}

async function setup(config: Record<string, unknown> = baseConfig(), depPatch: Partial<PipelineDeps> = {}) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "issue.comments.read"],
    config,
  });
  harness.seed({
    companies: [company()],
    issues: [issue()],
    agents: [
      agent(CLAUDE_ID, "claude"),
      agent(CODEX_ID, "codex"),
      agent(GROK_ID, "grok"),
      agent(KIMI_ID, "kimi"),
    ],
  });
  const invokes: InvokeCall[] = [];
  const originalInvoke = harness.ctx.agents.invoke.bind(harness.ctx.agents);
  harness.ctx.agents.invoke = async (agentId, companyId, opts) => {
    const result = await originalInvoke(agentId, companyId, opts);
    invokes.push({
      agentId,
      runId: result.runId,
      prompt: opts.prompt,
      reason: opts.reason,
      issueId: opts.issueId,
      taskKey: opts.taskKey,
      escalationCwd: opts.escalationCwd,
    });
    return result;
  };
  const judged: Array<{ model: string; record: EscalationRecord }> = [];
  const posted: EscalationRecord[] = [];
  const updated: EscalationRecord[] = [];
  const ephemerals: Array<{ channel: string; user: string; text: string }> = [];
  const modals: Array<{ triggerId: string; escalationId: string }> = [];
  const scheduled: Array<() => void> = [];
  const deps: PipelineDeps = {
    now: () => "2026-10-09T12:00:00.000Z",
    readPorcelain: async () => ({ ok: true, porcelain: "" }),
    readHead: async () => ({ ok: true, head: "abc123" }),
    createProposalWorktree: async () => ({
      ok: true,
      path: "/tmp/seme-isolated",
      head: "abc123",
      porcelain: "",
      contentHash: "hash-clean",
    }),
    readContentHash: async () => ({ ok: true, hash: "hash-clean" }),
    removeProposalWorktree: async () => {},
    schedule: (_ms, fn) => {
      scheduled.push(fn);
      return () => undefined;
    },
    async judge(record, model) {
      judged.push({ model, record });
      return { decision: "Use the Codex diff", reason: "It names the failing line." };
    },
    async postSlack(record) {
      posted.push(structuredClone(record));
      return { channel: CHANNEL, ts: "1700000000.000100" };
    },
    async updateSlack(record) {
      updated.push(structuredClone(record));
    },
    async postEphemeral(input) {
      ephemerals.push(input);
    },
    async openRejectModal(intent) {
      modals.push({ triggerId: intent.triggerId, escalationId: intent.escalationId });
    },
    ...depPatch,
  };
  setPipelineOverrides(deps);
  await plugin.definition.setup(harness.ctx);
  return { harness, invokes, judged, posted, updated, ephemerals, modals, deps, scheduled };
}

async function emit(
  harness: Awaited<ReturnType<typeof setup>>["harness"],
  eventType: "agent.run.failed" | "agent.run.finished" | "agent.run.cancelled",
  payload: Record<string, unknown>,
) {
  await harness.emit(eventType, payload, { companyId: COMPANY_ID });
}

async function currentEscalation(harness: Awaited<ReturnType<typeof setup>>["harness"]) {
  const rows = await listEscalationsForIssue(harness.ctx, COMPANY_ID, ISSUE_ID);
  return rows[0] ?? null;
}

function actionIds(body: Record<string, unknown>): string[] {
  const blocks = Array.isArray(body.blocks) ? body.blocks : [];
  const actions = blocks.find((block) => {
    return Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "actions";
  }) as { elements?: Array<{ action_id?: string }> } | undefined;
  return (actions?.elements ?? []).map((element) => element.action_id ?? "");
}

function stuckFanout(proposals: EscalationRecord["proposals"]): EscalationRecord {
  return {
    id: "esc-stuck",
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    failedRunId: "run-stuck",
    failedAgentId: CLAUDE_ID,
    failedAdapterType: "claude_local",
    error: "adapter exploded",
    errorCode: "adapter_failed",
    stdoutExcerpt: null,
    stderrExcerpt: null,
    repoUrl: null,
    repoRef: null,
    branchName: null,
    cwd: "/tmp/seme",
    baselinePorcelain: null,
    candidates: ["codex_local", "grok_build"],
    proposals,
    judge: null,
    status: "fanning_out",
    slack: null,
    decision: null,
    failureNote: null,
    version: 2,
    delivery: null,
    proposalDeadlineAt: null,
    createdAt: "2026-10-09T12:00:00.000Z",
    updatedAt: "2026-10-09T12:00:00.000Z",
  };
}

function readySlot(adapterType: string, text: string): EscalationRecord["proposals"][number] {
  return {
    adapterType,
    agentId: adapterType === "codex_local" ? CODEX_ID : GROK_ID,
    runId: `run-${adapterType}`,
    text,
    dirty: false,
    discarded: false,
    discardReason: null,
    status: "ready",
    error: null,
    worktreePath: null,
    baselineHead: "abc123",
    baselinePorcelain: "",
    baselineContentHash: "hash-clean",
  };
}

afterEach(() => {
  setPipelineOverrides(null);
});

describe("error escalation pipeline", () => {
  it("fans out to the next two harnesses, judges once, and posts Slack buttons", async () => {
    const { harness, invokes, judged, posted } = await setup();
    await emit(harness, "agent.run.failed", failurePayload());

    expect(invokes.map((call) => call.agentId)).toEqual([CODEX_ID, GROK_ID]);
    expect(invokes.every((call) => call.reason === "error_escalation_proposal")).toBe(true);
    expect(invokes.every((call) => call.issueId == null)).toBe(true);
    expect(invokes.every((call) => call.escalationCwd === "/tmp/seme-isolated")).toBe(true);
    expect(new Set(invokes.map((call) => call.taskKey)).size).toBe(2);
    expect(invokes.every((call) => call.taskKey?.startsWith("error-escalation:"))).toBe(true);
    expect(invokes.every((call) => !call.taskKey?.includes(ISSUE_ID))).toBe(true);
    expect(invokes[0]?.prompt).toContain("Do not edit files");
    expect(invokes[0]?.prompt).toContain(ISSUE_ID);
    expect(judged).toHaveLength(0);
    expect((await currentEscalation(harness))?.status).toBe("fanning_out");

    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      adapterType: "codex_local",
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff --git a/src/a.ts b/src/a.ts\n+fix",
    });
    expect(judged).toHaveLength(0);

    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      adapterType: "grok_build",
      status: "succeeded",
      wakeReason: "error_escalation_proposal",
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff --git a/src/b.ts b/src/b.ts\n+other",
    });

    expect(judged).toHaveLength(1);
    expect(judged[0]?.model).toBe("openrouter/free");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.status).toBe("judging");
    expect(posted[0]?.judge).toBeTruthy();
    const approvalBodies: Array<Record<string, unknown>> = [];
    await postEscalationMessage({
      transport: {
        fetch: async (_url, init) => {
          approvalBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true, channel: CHANNEL, ts: "1.1" }), { status: 200 });
        },
      },
      token: "xoxb-test",
      channel: CHANNEL,
      record: posted[0]!,
    });
    expect(actionIds(approvalBodies[0]!)).toEqual([SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION]);
    const record = await currentEscalation(harness);
    expect(record?.status).toBe("awaiting_approval");
    expect(record?.slack).toEqual({ channel: CHANNEL, ts: "1700000000.000100" });
    expect(invokes).toHaveLength(2);

    await emit(harness, "agent.run.failed", failurePayload());
    expect(invokes).toHaveLength(2);

    const before = invokes.length;
    await emit(harness, "agent.run.failed", failurePayload({
      runId: "proposal-run-not-a-new-failure",
      agentId: CODEX_ID,
      adapterType: "codex_local",
      escalationProposal: true,
    }));
    expect(invokes).toHaveLength(before);
  });

  it("does not start a fan-out for a proposal wake", async () => {
    const { harness, invokes } = await setup();
    await emit(harness, "agent.run.failed", failurePayload({
      runId: "proposal-only",
      escalationProposal: true,
      wakeReason: "error_escalation_proposal",
    }));
    expect(invokes).toHaveLength(0);
    expect(await currentEscalation(harness)).toBeNull();
  });

  it("discards a dirty proposal and does not call the judge when nothing is usable", async () => {
    const { harness, invokes, judged, posted } = await setup(baseConfig(), {
      readPorcelain: async () => ({ ok: true, porcelain: "?? new.ts" }),
    });
    await emit(harness, "agent.run.failed", failurePayload());
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "should be discarded",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "also discarded",
    });
    expect(judged).toHaveLength(0);
    expect(posted[0]?.status).toBe("failed");
    expect(posted[0]?.failureNote).toContain("Nothing was sent to the judge");
    const record = await currentEscalation(harness);
    expect(record?.proposals.every((proposal) => proposal.status === "discarded")).toBe(true);
    const message = buildApprovalMessage(posted[0]!, posted[0]!.status === "awaiting_approval");
    expect(message.blocks.some((block) => block.type === "actions")).toBe(false);
  });

  it("discards a proposal when git status cannot be read", async () => {
    const { harness, invokes, judged } = await setup(baseConfig(), {
      readPorcelain: async () => ({ ok: false, error: "git status failed" }),
    });
    await emit(harness, "agent.run.failed", failurePayload({ runId: "git-down" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff",
    });
    expect(judged).toHaveLength(0);
    expect((await currentEscalation(harness))?.proposals.every((proposal) => proposal.status === "discarded")).toBe(true);
  });

  it("keeps an isolated worktree when the proposal does not change it", async () => {
    const { harness, invokes, judged } = await setup(baseConfig(), {
      createProposalWorktree: async () => ({
        ok: true,
        path: "/tmp/seme-isolated",
        head: "abc123",
        porcelain: " M already.ts",
        contentHash: "hash-clean",
      }),
      readPorcelain: async () => ({ ok: true, porcelain: " M already.ts" }),
      readHead: async () => ({ ok: true, head: "abc123" }),
    });
    await emit(harness, "agent.run.failed", failurePayload({ runId: "dirty-baseline" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff --git a/ok",
    });
    await emit(harness, "agent.run.cancelled", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "cancelled",
      escalationProposal: true,
      error: "cancelled",
    });
    expect(judged).toHaveLength(1);
    const record = await currentEscalation(harness);
    expect(record?.proposals.find((proposal) => proposal.adapterType === "codex_local")?.status).toBe("ready");
    expect(record?.proposals.find((proposal) => proposal.adapterType === "grok_build")?.status).toBe("failed");
  });

  it("records approval once and does not invoke another agent", async () => {
    const { harness, invokes, updated, ephemerals } = await setup(baseConfig({ autoApply: true, applyOnApprove: true }));
    await emit(harness, "agent.run.failed", failurePayload());
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff --git a/src/a.ts",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff --git a/src/b.ts",
    });
    const record = await currentEscalation(harness);
    expect(record?.status).toBe("awaiting_approval");
    const invokeCount = invokes.length;

    await harness.emit("plugin.unused", {}, { companyId: COMPANY_ID });
    const approve = {
      payload: {
        type: "block_actions",
        user: { id: APPROVER },
        channel: { id: CHANNEL },
        message: { ts: record!.slack!.ts },
        actions: [{ action_id: SLACK_APPROVE_ACTION, value: record!.id }],
      },
    };
    const { handleSlackEnvelope } = await import("../src/pipeline.js");
    await handleSlackEnvelope(harness.ctx, approve);
    await handleSlackEnvelope(harness.ctx, approve);

    expect(invokes).toHaveLength(invokeCount);
    expect(updated).toHaveLength(1);
    expect((await currentEscalation(harness))?.status).toBe("approved");
    expect((await currentEscalation(harness))?.decision?.outcome).toBe("approved");
    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments[0]?.body).toContain("Nothing was written");
    expect(harness.logs.some((entry) => entry.message.includes("autoApply and applyOnApprove are ignored"))).toBe(true);
    expect(ephemerals).toHaveLength(0);

    const wrongUser = {
      payload: {
        type: "block_actions",
        user: { id: "U_OTHER" },
        channel: { id: CHANNEL },
        message: { ts: record!.slack!.ts },
        actions: [{ action_id: SLACK_APPROVE_ACTION, value: record!.id }],
      },
    };
    await handleSlackEnvelope(harness.ctx, wrongUser);
    expect(ephemerals.at(-1)?.text).toBe("Only Dan can decide this escalation.");
    expect((await currentEscalation(harness))?.status).toBe("approved");
  });

  it("rejects a mismatched channel or timestamp and accepts one thread reply", async () => {
    const { harness, invokes, updated } = await setup();
    await emit(harness, "agent.run.failed", failurePayload({ runId: "run-thread" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff 2",
    });
    const record = await currentEscalation(harness);
    const { applySlackIntent } = await import("../src/pipeline.js");
    const channel = await applySlackIntent(harness.ctx, {
      type: "thread_reply",
      userId: APPROVER,
      channelId: "C-OTHER",
      threadTs: record!.slack!.ts,
      outcome: "approved",
      reason: null,
    });
    expect(channel.applied).toBe(false);
    expect(channel.reason).toBe("channel mismatch");

    const timestamp = await applySlackIntent(harness.ctx, {
      type: "approve",
      escalationId: record!.id,
      userId: APPROVER,
      channelId: CHANNEL,
      messageTs: "999.999",
      reason: null,
    });
    expect(timestamp.applied).toBe(false);
    expect(timestamp.reason).toContain("timestamp");
    expect((await currentEscalation(harness))?.status).toBe("awaiting_approval");

    const reply = await applySlackIntent(harness.ctx, {
      type: "thread_reply",
      userId: APPROVER,
      channelId: CHANNEL,
      threadTs: record!.slack!.ts,
      outcome: "rejected",
      reason: "not this",
    });
    expect(reply.applied).toBe(true);
    expect(updated).toHaveLength(1);
    const decided = await currentEscalation(harness);
    expect(decided?.status).toBe("rejected");
    expect(decided?.decision?.reason).toBe("not this");
    const again = await applySlackIntent(harness.ctx, {
      type: "thread_reply",
      userId: APPROVER,
      channelId: CHANNEL,
      threadTs: record!.slack!.ts,
      outcome: "approved",
      reason: null,
    });
    expect(again.applied).toBe(false);
    expect(again.reason).toBe("already decided");
    expect((await currentEscalation(harness))?.status).toBe("rejected");
  });

  it("requires a reject reason from the modal and ignores a second decision", async () => {
    const { harness, invokes, modals, updated } = await setup();
    await emit(harness, "agent.run.failed", failurePayload({ runId: "run-modal" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff 2",
    });
    const record = await currentEscalation(harness);
    const { handleSlackEnvelope } = await import("../src/pipeline.js");
    await handleSlackEnvelope(harness.ctx, {
      payload: {
        type: "block_actions",
        trigger_id: "trigger-1",
        user: { id: APPROVER },
        channel: { id: CHANNEL },
        message: { ts: record!.slack!.ts },
        actions: [{ action_id: SLACK_REJECT_ACTION, value: record!.id }],
      },
    });
    expect(modals).toEqual([{ triggerId: "trigger-1", escalationId: record!.id }]);
    expect((await currentEscalation(harness))?.status).toBe("awaiting_approval");

    await handleSlackEnvelope(harness.ctx, {
      payload: {
        type: "view_submission",
        user: { id: APPROVER },
        view: {
          callback_id: SLACK_REJECT_CALLBACK,
          private_metadata: JSON.stringify({
            escalationId: record!.id,
            channelId: CHANNEL,
            messageTs: record!.slack!.ts,
          }),
          state: { values: { reason_block: { reason: { value: "too broad" } } } },
        },
      },
    });
    expect((await currentEscalation(harness))?.status).toBe("rejected");
    expect((await currentEscalation(harness))?.decision?.reason).toBe("too broad");
    expect(updated).toHaveLength(1);
    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments[0]?.body).toContain("too broad");

    await handleSlackEnvelope(harness.ctx, {
      payload: {
        type: "block_actions",
        user: { id: APPROVER },
        channel: { id: CHANNEL },
        message: { ts: record!.slack!.ts },
        actions: [{ action_id: SLACK_APPROVE_ACTION, value: record!.id }],
      },
    });
    expect((await currentEscalation(harness))?.status).toBe("rejected");
    expect(updated).toHaveLength(1);
  });

  it("exposes a read-only issue data view", async () => {
    const { harness, invokes } = await setup();
    await emit(harness, "agent.run.failed", failurePayload({ runId: "run-view" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff --git a/src/a.ts",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      cwd: "/tmp/seme",
      stdoutExcerpt: "diff --git a/src/b.ts",
    });
    const view = await harness.getData<{ escalations: Array<{ status: string; judge: { decision: string } | null }> }>("escalation", {
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
    });
    expect(view.escalations).toHaveLength(1);
    expect(view.escalations[0]?.status).toBe("awaiting_approval");
    expect(view.escalations[0]?.judge?.decision).toBe("Use the Codex diff");
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  it("does not return another company's issue", async () => {
    const { harness } = await setup();
    await emit(harness, "agent.run.failed", failurePayload({ runId: "run-scope" }));
    const other = "99999999-9999-4999-8999-999999999999";
    const view = await harness.getData<{ escalations: unknown[] }>("escalation", {
      companyId: other,
      issueId: ISSUE_ID,
    });
    expect(view.escalations).toEqual([]);
  });

  it("rejects every decision when no approver is configured", async () => {
    const { harness, invokes } = await setup(baseConfig({ slackApproverUserId: "  " }));
    await emit(harness, "agent.run.failed", failurePayload({ runId: "run-no-approver" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff 2",
    });
    const record = await currentEscalation(harness);
    const { applySlackIntent } = await import("../src/pipeline.js");
    const approve = await applySlackIntent(harness.ctx, {
      type: "approve",
      escalationId: record!.id,
      userId: APPROVER,
      channelId: CHANNEL,
      messageTs: record!.slack!.ts,
      reason: null,
    });
    const reply = await applySlackIntent(harness.ctx, {
      type: "thread_reply",
      userId: "U_ANY",
      channelId: CHANNEL,
      threadTs: record!.slack!.ts,
      outcome: "rejected",
      reason: "nope",
    });
    expect(approve.applied).toBe(false);
    expect(approve.reason).toBe("approver is not configured");
    expect(reply.applied).toBe(false);
    expect((await currentEscalation(harness))?.status).toBe("awaiting_approval");
  });

  it("asks kimi and claude after a process-adapter grok failure", async () => {
    const { invokes, harness } = await setup();
    await emit(harness, "agent.run.failed", failurePayload({
      runId: "grok-process",
      agentId: GROK_ID,
      adapterType: "process",
    }));
    expect(invokes.map((call) => call.agentId)).toEqual([KIMI_ID, CLAUDE_ID]);
    expect((await currentEscalation(harness))?.failedAdapterType).toBe("grok_build");
  });

  it("keeps a proposal that finishes before its run link is saved", async () => {
    const { harness, invokes, judged } = await setup();
    const original = harness.ctx.agents.invoke.bind(harness.ctx.agents);
    harness.ctx.agents.invoke = async (agentId, companyId, opts) => {
      const result = await original(agentId, companyId, opts);
      await emit(harness, "agent.run.finished", {
        runId: result.runId,
        agentId,
        status: "succeeded",
        escalationProposal: true,
        stdoutExcerpt: `answer ${agentId}`,
      });
      return result;
    };
    await emit(harness, "agent.run.failed", failurePayload({ runId: "early-finish" }));
    expect(invokes).toHaveLength(2);
    expect(judged).toHaveLength(1);
    const record = await currentEscalation(harness);
    expect(record?.proposals.every((proposal) => proposal.status === "ready")).toBe(true);
    expect(record?.status).toBe("awaiting_approval");
  });

  it("keeps both proposals when they finish together", async () => {
    const { harness, invokes, judged } = await setup();
    await emit(harness, "agent.run.failed", failurePayload({ runId: "concurrent" }));
    await Promise.all([
      emit(harness, "agent.run.finished", {
        runId: invokes[0]!.runId,
        agentId: CODEX_ID,
        status: "succeeded",
        escalationProposal: true,
        stdoutExcerpt: "diff one",
      }),
      emit(harness, "agent.run.finished", {
        runId: invokes[1]!.runId,
        agentId: GROK_ID,
        status: "succeeded",
        escalationProposal: true,
        stdoutExcerpt: "diff two",
      }),
    ]);
    const record = await currentEscalation(harness);
    expect(record?.proposals.map((proposal) => proposal.status)).toEqual(["ready", "ready"]);
    expect(judged).toHaveLength(1);
    expect(record?.status).toBe("awaiting_approval");
  });

  it("applies only one of a concurrent approve and reject", async () => {
    const { harness, invokes, updated } = await setup();
    await emit(harness, "agent.run.failed", failurePayload({ runId: "race-decision" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff 2",
    });
    const record = await currentEscalation(harness);
    const { applySlackIntent } = await import("../src/pipeline.js");
    const results = await Promise.all([
      applySlackIntent(harness.ctx, {
        type: "approve",
        escalationId: record!.id,
        userId: APPROVER,
        channelId: CHANNEL,
        messageTs: record!.slack!.ts,
        reason: null,
      }),
      applySlackIntent(harness.ctx, {
        type: "reject",
        escalationId: record!.id,
        userId: APPROVER,
        channelId: CHANNEL,
        messageTs: record!.slack!.ts,
        reason: "no",
      }),
    ]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(updated).toHaveLength(1);
    const decided = await currentEscalation(harness);
    expect(decided?.decision?.outcome).toBe(decided?.status);
    expect(["approved", "rejected"]).toContain(decided?.status);
  });

  it("retries a judge failure and then records a visible failure", async () => {
    let calls = 0;
    const { harness, invokes } = await setup(baseConfig({ proposalTimeoutSec: 0 }), {
      schedule: async (_ms, fn) => {
        await fn();
      },
      judge: async () => {
        calls += 1;
        if (calls < 2) throw new Error("openrouter down");
        return { decision: "Use Codex", reason: "retried" };
      },
    });
    await emit(harness, "agent.run.failed", failurePayload({ runId: "judge-retry" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff 2",
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect((await currentEscalation(harness))?.status).toBe("awaiting_approval");
    expect((await currentEscalation(harness))?.judge?.reason).toBe("retried");
  });

  it("stops retrying delivery and leaves a visible failed escalation", async () => {
    const { harness, invokes } = await setup(baseConfig({ proposalTimeoutSec: 0 }), {
      schedule: async (_ms, fn) => {
        await fn();
      },
      judge: async () => {
        throw new Error("openrouter down");
      },
    });
    await emit(harness, "agent.run.failed", failurePayload({ runId: "judge-exhausted" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff 2",
    });
    const record = await currentEscalation(harness);
    expect(record?.status).toBe("failed");
    expect(record?.failureNote).toContain("openrouter down");
    expect(record?.delivery?.retryable).toBe(false);
    const view = await harness.getData<{ escalations: Array<{ status: string; failureNote: string | null }> }>("escalation", {
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
    });
    expect(view.escalations[0]?.status).toBe("failed");
    expect(view.escalations[0]?.failureNote).toContain("openrouter down");
  });

  it("does not mark awaiting approval when Slack posting fails", async () => {
    let posts = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const postedStatuses: string[] = [];
    const { harness, invokes } = await setup(baseConfig({ proposalTimeoutSec: 0 }), {
      schedule: async (_ms, fn) => {
        await fn();
      },
      postSlack: async (record) => {
        posts += 1;
        postedStatuses.push(record.status);
        return postEscalationMessage({
          transport: {
            fetch: async (_url, init) => {
              bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
              if (posts === 1) throw new Error("slack down");
              return new Response(JSON.stringify({ ok: true, channel: CHANNEL, ts: "1700000000.000200" }), { status: 200 });
            },
          },
          token: "xoxb-test",
          channel: CHANNEL,
          record,
        });
      },
    });
    await emit(harness, "agent.run.failed", failurePayload({ runId: "slack-retry" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff 2",
    });
    const record = await currentEscalation(harness);
    expect(record?.status).toBe("awaiting_approval");
    expect(record?.slack?.ts).toBe("1700000000.000200");
    expect(record?.judge?.decision).toBe("Use the Codex diff");
    expect(postedStatuses).toEqual(["judging", "failed"]);
    expect(bodies).toHaveLength(2);
    expect(actionIds(bodies[0]!)).toEqual([SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION]);
    expect(actionIds(bodies[1]!)).toEqual([SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION]);
  });

  it("fails a proposal that exceeds proposalTimeoutSec and continues", async () => {
    const { harness, invokes, judged, scheduled } = await setup(baseConfig({ proposalTimeoutSec: 5 }));
    await emit(harness, "agent.run.failed", failurePayload({ runId: "timeout" }));
    expect(invokes).toHaveLength(2);
    expect(scheduled.length).toBeGreaterThan(0);
    await scheduled[0]!();
    const record = await currentEscalation(harness);
    expect(record?.proposals.every((proposal) => proposal.status === "failed")).toBe(true);
    expect(record?.proposals[0]?.error).toBe("Proposal timed out");
    expect(record?.status).toBe("failed");
    expect(judged).toHaveLength(0);
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "late",
    });
    expect((await currentEscalation(harness))?.proposals[0]?.text).toBeNull();
  });

  it("does not start a proposal in the real workspace when isolation fails", async () => {
    const { harness, invokes } = await setup(baseConfig(), {
      createProposalWorktree: async () => ({ ok: false, error: "not a git repo" }),
    });
    await emit(harness, "agent.run.failed", failurePayload({ runId: "no-worktree" }));
    expect(invokes).toHaveLength(0);
    const record = await currentEscalation(harness);
    expect(record?.proposals.every((proposal) => proposal.status === "failed")).toBe(true);
    expect(record?.status).toBe("failed");
  });

  it("discards a proposal that ran outside the isolated worktree", async () => {
    const { harness, invokes, judged } = await setup();
    await emit(harness, "agent.run.failed", failurePayload({ runId: "outside-cwd" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "edited the real checkout",
      executionCwd: "/tmp/real-checkout",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "stayed in the worktree",
      executionCwd: "/tmp/seme-isolated",
    });
    const record = await currentEscalation(harness);
    expect(record?.proposals.find((proposal) => proposal.adapterType === "codex_local")?.status).toBe("discarded");
    expect(record?.proposals.find((proposal) => proposal.adapterType === "codex_local")?.discardReason).toContain("isolated worktree");
    expect(record?.proposals.find((proposal) => proposal.adapterType === "grok_build")?.status).toBe("ready");
    expect(judged).toHaveLength(1);
  });

  it("still judges when the last proposal worktree cleanup throws", async () => {
    let removals = 0;
    const pendingOnLastCleanup: string[] = [];
    let harnessRef: Awaited<ReturnType<typeof setup>>["harness"] | null = null;
    const result = await setup(baseConfig(), {
      removeProposalWorktree: async () => {
        removals += 1;
        if (removals < 2 || !harnessRef) return;
        pendingOnLastCleanup.push(...(await listPendingDeliveries(harnessRef.ctx)).map((entry) => entry.id));
        throw new Error("cleanup failed");
      },
    });
    harnessRef = result.harness;
    const { harness, invokes, judged, posted } = result;
    await emit(harness, "agent.run.failed", failurePayload({ runId: "cleanup-throw" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff one",
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "diff two",
    });
    const record = await currentEscalation(harness);
    expect(pendingOnLastCleanup).toContain(record?.id);
    expect(judged).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(record?.status).toBe("awaiting_approval");
  });

  it("resumes a finished fan-out that never reached the judge", async () => {
    const { harness, judged, posted } = await setup();
    const record = stuckFanout([
      readySlot("codex_local", "diff one"),
      readySlot("grok_build", "diff two"),
    ]);
    await saveEscalation(harness.ctx, record);
    await rememberPendingDelivery(harness.ctx, COMPANY_ID, record.id, true);
    await resumeEscalations(harness.ctx);
    expect(judged).toHaveLength(1);
    expect(posted).toHaveLength(1);
    const saved = await currentEscalation(harness);
    expect(saved?.status).toBe("awaiting_approval");
  });

  it("does not judge a fan-out that has not recorded every slot", async () => {
    const { harness, invokes, judged } = await setup();
    const record = stuckFanout([]);
    await saveEscalation(harness.ctx, record);
    await rememberPendingDelivery(harness.ctx, COMPANY_ID, record.id, true);
    await resumeEscalations(harness.ctx);
    expect(judged).toHaveLength(0);
    const saved = await currentEscalation(harness);
    expect(saved?.status).toBe("fanning_out");
    expect(invokes).toHaveLength(2);
    expect(saved?.proposals).toHaveLength(2);
    expect(saved?.proposals.every((proposal) => proposal.status === "pending")).toBe(true);
  });

  it("starts missing slots again when the failed run is delivered after a restart", async () => {
    const { harness, invokes } = await setup();
    const record = stuckFanout([]);
    record.failedRunId = "run-redeliver";
    await saveEscalation(harness.ctx, record);
    await emit(harness, "agent.run.failed", failurePayload({ runId: "run-redeliver" }));
    const saved = await currentEscalation(harness);
    expect(invokes).toHaveLength(2);
    expect(saved?.proposals).toHaveLength(2);
    expect(saved?.status).toBe("fanning_out");
    expect(saved?.proposals.every((proposal) => proposal.status === "pending")).toBe(true);
  });

  it("keeps going when invoke fails and worktree cleanup also throws", async () => {
    let removals = 0;
    const { harness, invokes } = await setup(baseConfig(), {
      removeProposalWorktree: async () => {
        removals += 1;
        throw new Error("cleanup failed");
      },
    });
    const wrapped = harness.ctx.agents.invoke.bind(harness.ctx.agents);
    let attempts = 0;
    harness.ctx.agents.invoke = async (agentId, companyId, opts) => {
      attempts += 1;
      if (attempts === 1) throw new Error("invoke failed");
      return wrapped(agentId, companyId, opts);
    };
    await emit(harness, "agent.run.failed", failurePayload({ runId: "cleanup-invoke" }));
    const record = await currentEscalation(harness);
    expect(removals).toBe(1);
    expect(record?.proposals).toHaveLength(2);
    expect(record?.proposals[0]?.status).toBe("failed");
    expect(record?.proposals[0]?.error).toBe("invoke failed");
    expect(record?.proposals[1]?.status).toBe("pending");
    expect(invokes).toHaveLength(1);
  });

  it("judges the extracted final answer instead of the raw output tail", async () => {
    const answer = "Opening explanation of the fix.\n\ndiff --git a/src/a.ts b/src/a.ts\n+the rest of the answer";
    const { harness, invokes, judged } = await setup();
    await emit(harness, "agent.run.failed", failurePayload({ runId: "summary-run" }));
    await emit(harness, "agent.run.finished", {
      runId: invokes[0]!.runId,
      agentId: CODEX_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "TAIL-ONLY",
      resultSummary: answer,
    });
    await emit(harness, "agent.run.finished", {
      runId: invokes[1]!.runId,
      agentId: GROK_ID,
      status: "succeeded",
      escalationProposal: true,
      stdoutExcerpt: "TAIL-ONLY",
      resultSummary: answer,
    });
    expect(judged).toHaveLength(1);
    expect(judged[0]?.record.proposals.map((proposal) => proposal.text)).toEqual([answer, answer]);
  });

  it("escalates only companies listed in companyIds", async () => {
    const { harness, invokes } = await setup(baseConfig({ companyIds: [COMPANY_ID] }));
    await harness.emit(
      "agent.run.failed",
      failurePayload({ runId: "other-company-run" }),
      { companyId: "99999999-9999-4999-8999-999999999999" },
    );
    expect(invokes).toHaveLength(0);
    await emit(harness, "agent.run.failed", failurePayload({ runId: "seme-run" }));
    expect(invokes.map((call) => call.agentId)).toEqual([CODEX_ID, GROK_ID]);
  });

  it("does not start a new escalation for a proposal wake", async () => {
    const { harness, invokes } = await setup(baseConfig({ companyIds: [COMPANY_ID] }));
    await emit(harness, "agent.run.failed", failurePayload({
      runId: "proposal-run",
      agentId: CODEX_ID,
      wakeReason: "error_escalation_proposal",
    }));
    expect(invokes).toHaveLength(0);
    await emit(harness, "agent.run.failed", failurePayload({
      runId: "ordinary-wake",
      wakeReason: "issue_assigned",
    }));
    expect(invokes.map((call) => call.agentId)).toEqual([CODEX_ID, GROK_ID]);
  });
});
