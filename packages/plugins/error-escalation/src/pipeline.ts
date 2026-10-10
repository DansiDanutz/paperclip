import { randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { parseEscalationConfig } from "./config.js";
import { PROPOSAL_WAKE_REASON } from "./constants.js";
import { buildProposalPrompt, parseRunActivity, type RunActivity } from "./failure.js";
import { proposalDirtiedWorktree, readPorcelain, type PorcelainResult } from "./git.js";
import { selectNextHarnesses } from "./harnesses.js";
import { requestJudge } from "./judge.js";
import {
  openRejectModal,
  parseSlackEnvelope,
  postEphemeral,
  postEscalationMessage,
  updateEscalationMessage,
  type SlackIntent,
  type SlackTransport,
} from "./slack.js";
import {
  findEscalationById,
  findEscalationBySlackMessage,
  loadEscalationByFailedRun,
  loadEscalationByProposalRun,
  saveEscalation,
  type EscalationRecord,
  type ProposalSlot,
} from "./state.js";

export interface PipelineDeps {
  now: () => string;
  readPorcelain: (cwd: string) => Promise<PorcelainResult>;
  judge: (record: EscalationRecord, model: string) => Promise<{ decision: string; reason: string }>;
  postSlack: (record: EscalationRecord) => Promise<{ channel: string; ts: string }>;
  updateSlack: (record: EscalationRecord) => Promise<void>;
  postEphemeral: (input: { channel: string; user: string; text: string }) => Promise<void>;
  openRejectModal: (input: SlackIntent & { type: "open_reject_modal" }) => Promise<void>;
}

const overrides: Partial<PipelineDeps> = {};
const finalizing = new Set<string>();

export function setPipelineOverrides(next: Partial<PipelineDeps> | null): void {
  for (const key of Object.keys(overrides) as Array<keyof PipelineDeps>) {
    delete overrides[key];
  }
  if (next) Object.assign(overrides, next);
}

function productionDeps(ctx: PluginContext): PipelineDeps {
  const transport: SlackTransport = {
    fetch: (url, init) => ctx.http.fetch(url, init),
  };
  return {
    now: () => new Date().toISOString(),
    readPorcelain: (cwd) => readPorcelain(cwd),
    async judge(record, model) {
      const config = parseEscalationConfig(await ctx.config.get());
      if (!config.openRouterApiKeySecretId) throw new Error("openRouterApiKeySecretId is not configured");
      const apiKey = await ctx.secrets.resolve(config.openRouterApiKeySecretId);
      return requestJudge({
        fetchImpl: (url, init) => ctx.http.fetch(url, init),
        apiKey,
        model,
        error: record.error,
        proposals: record.proposals,
      });
    },
    async postSlack(record) {
      const config = parseEscalationConfig(await ctx.config.get());
      if (!config.slackBotTokenSecretId || !config.slackChannelId) {
        throw new Error("Slack bot token or slackChannelId is not configured");
      }
      const token = await ctx.secrets.resolve(config.slackBotTokenSecretId);
      return postEscalationMessage({
        transport,
        token,
        channel: config.slackChannelId,
        record,
      });
    },
    async updateSlack(record) {
      const config = parseEscalationConfig(await ctx.config.get());
      if (!config.slackBotTokenSecretId) return;
      const token = await ctx.secrets.resolve(config.slackBotTokenSecretId);
      await updateEscalationMessage({ transport, token, record });
    },
    async postEphemeral(input) {
      const config = parseEscalationConfig(await ctx.config.get());
      if (!config.slackBotTokenSecretId) return;
      const token = await ctx.secrets.resolve(config.slackBotTokenSecretId);
      await postEphemeral({ transport, token, channel: input.channel, user: input.user, text: input.text });
    },
    async openRejectModal(intent) {
      const config = parseEscalationConfig(await ctx.config.get());
      if (!config.slackBotTokenSecretId) throw new Error("Slack bot token is not configured");
      const token = await ctx.secrets.resolve(config.slackBotTokenSecretId);
      await openRejectModal({
        transport,
        token,
        triggerId: intent.triggerId,
        escalationId: intent.escalationId,
        channelId: intent.channelId,
        messageTs: intent.messageTs,
      });
    },
  };
}

export function resolveDeps(ctx: PluginContext): PipelineDeps {
  return { ...productionDeps(ctx), ...overrides };
}

async function noteApplyFlags(ctx: PluginContext): Promise<void> {
  const raw = await ctx.config.get();
  if (raw.autoApply === true || raw.applyOnApprove === true) {
    ctx.logger.warn("autoApply and applyOnApprove are ignored. Approve only records the decision.");
  }
}

function slot(adapterType: string, agentId: string | null, status: ProposalSlot["status"], error: string | null): ProposalSlot {
  return {
    adapterType,
    agentId,
    runId: null,
    text: null,
    dirty: false,
    discarded: status === "discarded",
    discardReason: status === "discarded" ? error : null,
    status,
    error,
  };
}

async function publishDocuments(ctx: PluginContext, record: EscalationRecord): Promise<void> {
  if (!record.issueId) return;
  const body = [
    `# Escalation ${record.id}`,
    `Status: ${record.status}`,
    record.judge ? `Decision: ${record.judge.decision}\nReason: ${record.judge.reason}` : "",
    ...record.proposals.map((proposal) => `## ${proposal.adapterType} (${proposal.status})\n${proposal.text ?? proposal.error ?? ""}`),
  ].filter(Boolean).join("\n\n");
  try {
    await ctx.issues.documents.upsert({
      issueId: record.issueId,
      key: `escalation/${record.id}`,
      body,
      companyId: record.companyId,
      title: `Error escalation ${record.id}`,
      format: "markdown",
    });
  } catch (error) {
    ctx.logger.warn("Could not store escalation document", {
      escalationId: record.id,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

async function comment(ctx: PluginContext, record: EscalationRecord, body: string): Promise<void> {
  if (!record.issueId) return;
  try {
    await ctx.issues.createComment(record.issueId, body, record.companyId);
  } catch (error) {
    ctx.logger.warn("Could not comment on issue", {
      escalationId: record.id,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

async function finalize(ctx: PluginContext, record: EscalationRecord, deps: PipelineDeps): Promise<void> {
  if (record.proposals.some((proposal) => proposal.status === "pending")) return;
  if (record.status !== "fanning_out") return;
  if (finalizing.has(record.id)) return;
  finalizing.add(record.id);
  try {
    record.status = "judging";
    record.updatedAt = deps.now();
    await saveEscalation(ctx, record);
    const config = parseEscalationConfig(await ctx.config.get());
    const ready = record.proposals.filter((proposal) => proposal.status === "ready" && proposal.text);
    if (ready.length === 0) {
      record.status = "failed";
      record.failureNote = "Every proposal was discarded or failed. Nothing was sent to the judge.";
      record.updatedAt = deps.now();
      await saveEscalation(ctx, record);
      await publishDocuments(ctx, record);
      try {
        record.slack = await deps.postSlack(record);
        record.updatedAt = deps.now();
        await saveEscalation(ctx, record);
      } catch (error) {
        ctx.logger.warn("Slack delivery failed", { message: error instanceof Error ? error.message : "unknown" });
      }
      return;
    }
    const judged = await deps.judge(record, config.judgeModel);
    record.judge = { model: config.judgeModel, decision: judged.decision, reason: judged.reason };
    record.status = "awaiting_approval";
    record.updatedAt = deps.now();
    await saveEscalation(ctx, record);
    await publishDocuments(ctx, record);
    record.slack = await deps.postSlack(record);
    record.updatedAt = deps.now();
    await saveEscalation(ctx, record);
  } finally {
    finalizing.delete(record.id);
  }
}

async function checkDirty(deps: PipelineDeps, record: EscalationRecord, proposalCwd: string | null): Promise<{ dirty: boolean; error?: string }> {
  const cwd = proposalCwd || record.cwd;
  if (!cwd) return { dirty: false };
  const current = await deps.readPorcelain(cwd);
  return proposalDirtiedWorktree({
    cwd,
    baselineCwd: record.cwd,
    baselinePorcelain: record.baselinePorcelain,
    current,
  });
}

export async function handleRunEvent(ctx: PluginContext, event: PluginEvent, deps: PipelineDeps = resolveDeps(ctx)): Promise<void> {
  const config = parseEscalationConfig(await ctx.config.get());
  if (!config.enabled) return;
  const activity = parseRunActivity(event);
  if (!activity) return;

  if (activity.escalationProposal) {
    await ingestProposal(ctx, activity, deps);
    return;
  }
  if (event.eventType !== "agent.run.failed") return;
  await startEscalation(ctx, activity, deps);
}

async function startEscalation(ctx: PluginContext, failure: RunActivity, deps: PipelineDeps): Promise<void> {
  const existing = await loadEscalationByFailedRun(ctx, failure.companyId, failure.runId);
  if (existing) return;
  const config = parseEscalationConfig(await ctx.config.get());
  const candidates = selectNextHarnesses(failure.adapterType, config.harnessOrder, config.fanoutCount);
  const now = deps.now();
  const baseline = failure.cwd ? await deps.readPorcelain(failure.cwd) : null;
  const record: EscalationRecord = {
    id: randomUUID(),
    companyId: failure.companyId,
    issueId: failure.issueId,
    failedRunId: failure.runId,
    failedAgentId: failure.agentId,
    failedAdapterType: failure.adapterType,
    error: failure.error,
    errorCode: failure.errorCode,
    stdoutExcerpt: failure.stdoutExcerpt,
    stderrExcerpt: failure.stderrExcerpt,
    repoUrl: failure.repoUrl,
    repoRef: failure.repoRef,
    branchName: failure.branchName,
    cwd: failure.cwd,
    baselinePorcelain: baseline && baseline.ok ? baseline.porcelain : null,
    candidates,
    proposals: [],
    judge: null,
    status: "fanning_out",
    slack: null,
    decision: null,
    failureNote: null,
    createdAt: now,
    updatedAt: now,
  };

  for (const harness of candidates) {
    const agentId = config.harnessAgents[harness as keyof typeof config.harnessAgents] ?? "";
    if (!agentId) {
      record.proposals.push(slot(harness, null, "failed", "Proposal agent is not configured"));
      continue;
    }
    try {
      const invoked = await ctx.agents.invoke(agentId, failure.companyId, {
        prompt: buildProposalPrompt(failure, harness),
        reason: PROPOSAL_WAKE_REASON,
        issueId: failure.issueId ?? undefined,
      });
      record.proposals.push({
        ...slot(harness, agentId, "pending", null),
        runId: invoked.runId,
      });
    } catch (error) {
      record.proposals.push(slot(
        harness,
        agentId,
        "failed",
        error instanceof Error ? error.message : "invoke failed",
      ));
    }
  }

  record.updatedAt = deps.now();
  await saveEscalation(ctx, record);
  await finalize(ctx, record, deps);
}

async function ingestProposal(ctx: PluginContext, activity: RunActivity, deps: PipelineDeps): Promise<void> {
  const record = await loadEscalationByProposalRun(ctx, activity.companyId, activity.runId);
  if (!record) return;
  const proposal = record.proposals.find((entry) => entry.runId === activity.runId);
  if (!proposal || proposal.status !== "pending") return;

  if (activity.eventType === "agent.run.cancelled" || activity.eventType === "agent.run.failed") {
    proposal.status = "failed";
    proposal.error = activity.error ?? activity.status;
    record.updatedAt = deps.now();
    await saveEscalation(ctx, record);
    await finalize(ctx, record, deps);
    return;
  }

  const dirty = await checkDirty(deps, record, activity.cwd);
  if (dirty.dirty) {
    proposal.status = "discarded";
    proposal.discarded = true;
    proposal.dirty = true;
    proposal.discardReason = dirty.error ?? "Workspace was dirty after the proposal run";
    proposal.text = null;
  } else {
    proposal.status = "ready";
    proposal.text = activity.stdoutExcerpt || activity.stderrExcerpt || "(no output)";
  }
  record.updatedAt = deps.now();
  await saveEscalation(ctx, record);
  await finalize(ctx, record, deps);
}

function decisionMatches(record: EscalationRecord, channelId: string, messageTs: string, approverUserId: string, actorId: string): string | null {
  if (!record.slack) return "Escalation has no Slack message";
  if (record.slack.channel !== channelId || record.slack.ts !== messageTs) return "Slack channel or timestamp does not match";
  if (approverUserId && actorId !== approverUserId) return "Only the configured approver can decide";
  return null;
}

export async function applySlackIntent(ctx: PluginContext, intent: SlackIntent, deps: PipelineDeps = resolveDeps(ctx)): Promise<{ applied: boolean; reason?: string }> {
  const config = parseEscalationConfig(await ctx.config.get());
  if (intent.type === "ignore") return { applied: false, reason: "ignored" };
  if (intent.type === "open_reject_modal") {
    const loaded = await findEscalationById(ctx, intent.escalationId);
    if (!loaded) return { applied: false, reason: "missing" };
    const mismatch = decisionMatches(loaded, intent.channelId, intent.messageTs, config.slackApproverUserId, intent.userId);
    if (mismatch) {
      if (mismatch.startsWith("Only the configured")) {
        await deps.postEphemeral({ channel: intent.channelId, user: intent.userId, text: "Only Dan can decide this escalation." });
      }
      return { applied: false, reason: mismatch };
    }
    if (loaded.status !== "awaiting_approval") return { applied: false, reason: "not awaiting approval" };
    await deps.openRejectModal(intent);
    return { applied: true };
  }

  let record: EscalationRecord | null = null;
  let outcome: "approved" | "rejected" | null = null;
  let reason: string | null = null;
  let actorId = "";
  let channelId = "";
  let messageTs = "";

  if (intent.type === "approve" || intent.type === "reject") {
    record = await findEscalationById(ctx, intent.escalationId);
    outcome = intent.type === "approve" ? "approved" : "rejected";
    reason = intent.reason;
    actorId = intent.userId;
    channelId = intent.channelId;
    messageTs = intent.messageTs;
  } else if (intent.type === "thread_reply") {
    channelId = intent.channelId;
    messageTs = intent.threadTs;
    actorId = intent.userId;
    outcome = intent.outcome;
    reason = intent.reason;
    record = await findEscalationBySlackMessage(ctx, intent.channelId, intent.threadTs);
  }

  if (config.slackChannelId && channelId !== config.slackChannelId) {
    return { applied: false, reason: "channel mismatch" };
  }
  if (!record || !outcome) return { applied: false, reason: "missing" };
  const mismatch = decisionMatches(record, channelId, messageTs, config.slackApproverUserId, actorId);
  if (mismatch) {
    if (mismatch.startsWith("Only the configured")) {
      await deps.postEphemeral({ channel: channelId, user: actorId, text: "Only Dan can decide this escalation." });
    }
    return { applied: false, reason: mismatch };
  }
  if (record.status !== "awaiting_approval") {
    return { applied: false, reason: "already decided" };
  }
  await noteApplyFlags(ctx);
  record.status = outcome;
  record.decision = { outcome, actorId, reason, at: deps.now() };
  record.updatedAt = deps.now();
  await saveEscalation(ctx, record);
  await deps.updateSlack(record);
  await comment(
    ctx,
    record,
    outcome === "approved"
      ? `Dan approved escalation ${record.id}. Nothing was written.`
      : `Dan rejected escalation ${record.id}.${reason ? ` Reason: ${reason}` : ""}`,
  );
  return { applied: true };
}

export async function handleSlackEnvelope(ctx: PluginContext, envelope: unknown, deps: PipelineDeps = resolveDeps(ctx)): Promise<void> {
  await applySlackIntent(ctx, parseSlackEnvelope(envelope), deps);
}

export { parseSlackEnvelope };
