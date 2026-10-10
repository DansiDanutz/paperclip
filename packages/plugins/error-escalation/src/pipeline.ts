import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { companyAllowed, parseEscalationConfig, type EscalationConfig } from "./config.js";
import { PROPOSAL_WAKE_REASON } from "./constants.js";
import { buildProposalPrompt, parseRunActivity, type RunActivity } from "./failure.js";
import {
  createProposalWorktree,
  proposalChangedIsolation,
  readHead,
  readPorcelain,
  removeProposalWorktree,
  type PorcelainResult,
  type ProposalWorktree,
} from "./git.js";
import { resolveFailedHarness, selectNextHarnesses } from "./harnesses.js";
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
  listPendingDeliveries,
  loadEscalation,
  loadEscalationByFailedRun,
  loadEscalationByProposalRun,
  mutateEscalation,
  rememberPendingDelivery,
  saveEarlyProposal,
  saveEscalation,
  takeEarlyProposal,
  withRecordLock,
  type EscalationRecord,
  type ProposalSlot,
} from "./state.js";

const DELIVERY_MAX_ATTEMPTS = 3;

export interface PipelineDeps {
  now: () => string;
  readPorcelain: (cwd: string) => Promise<PorcelainResult>;
  readHead: (cwd: string) => Promise<{ ok: true; head: string } | { ok: false; error: string }>;
  createProposalWorktree: (sourceCwd: string) => Promise<ProposalWorktree>;
  removeProposalWorktree: (sourceCwd: string | null, worktreePath: string) => Promise<void>;
  schedule: (ms: number, fn: () => void | Promise<void>) => (() => void) | Promise<void>;
  judge: (record: EscalationRecord, model: string) => Promise<{ decision: string; reason: string }>;
  postSlack: (record: EscalationRecord) => Promise<{ channel: string; ts: string }>;
  updateSlack: (record: EscalationRecord) => Promise<void>;
  postEphemeral: (input: { channel: string; user: string; text: string }) => Promise<void>;
  openRejectModal: (input: SlackIntent & { type: "open_reject_modal" }) => Promise<void>;
}

const overrides: Partial<PipelineDeps> = {};
/**
 * Config last delivered by the host's company-scoped `configChanged`.
 * Events are global, and an unconfigured company's `config.get()` is `{}`,
 * which parses as enabled for everyone. The cached config is the one the
 * operator saved, including `companyIds`.
 */
let activeConfig: EscalationConfig | null = null;

export function setActiveEscalationConfig(config: EscalationConfig | null): void {
  activeConfig = config;
}

async function loadConfig(ctx: PluginContext): Promise<EscalationConfig> {
  if (activeConfig) return activeConfig;
  return parseEscalationConfig(await ctx.config.get());
}
const delivering = new Set<string>();
const timeoutArmed = new Set<string>();
const fanoutOpen = new Set<string>();

export function setPipelineOverrides(next: Partial<PipelineDeps> | null): void {
  for (const key of Object.keys(overrides) as Array<keyof PipelineDeps>) {
    delete overrides[key];
  }
  timeoutArmed.clear();
  fanoutOpen.clear();
  if (next) Object.assign(overrides, next);
  activeConfig = null;
}

function productionDeps(ctx: PluginContext): PipelineDeps {
  const transport: SlackTransport = {
    fetch: (url, init) => ctx.http.fetch(url, init),
  };
  return {
    now: () => new Date().toISOString(),
    readPorcelain: (cwd) => readPorcelain(cwd),
    readHead: (cwd) => readHead(cwd),
    createProposalWorktree: (cwd) => createProposalWorktree(cwd),
    removeProposalWorktree: (cwd, worktreePath) => removeProposalWorktree(cwd, worktreePath),
    schedule: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    async judge(record, model) {
      const config = await loadConfig(ctx);
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
      const config = await loadConfig(ctx);
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
      const config = await loadConfig(ctx);
      if (!config.slackBotTokenSecretId) return;
      const token = await ctx.secrets.resolve(config.slackBotTokenSecretId);
      await updateEscalationMessage({ transport, token, record });
    },
    async postEphemeral(input) {
      const config = await loadConfig(ctx);
      if (!config.slackBotTokenSecretId) return;
      const token = await ctx.secrets.resolve(config.slackBotTokenSecretId);
      await postEphemeral({ transport, token, channel: input.channel, user: input.user, text: input.text });
    },
    async openRejectModal(intent) {
      const config = await loadConfig(ctx);
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

function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
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
    worktreePath: null,
    baselineHead: null,
    baselinePorcelain: null,
  };
}

function fanoutReadyToJudge(record: EscalationRecord): boolean {
  return record.status === "fanning_out"
    && record.candidates.length > 0
    && record.proposals.length >= record.candidates.length
    && !record.proposals.some((proposal) => proposal.status === "pending");
}

function needsResume(record: EscalationRecord): boolean {
  return record.proposals.some((proposal) => proposal.status === "pending")
    || record.status === "judging"
    || (record.status === "failed" && record.delivery?.retryable === true)
    || fanoutReadyToJudge(record);
}

async function syncPending(ctx: PluginContext, record: EscalationRecord): Promise<void> {
  await rememberPendingDelivery(ctx, record.companyId, record.id, needsResume(record));
}

async function updateRecord(
  ctx: PluginContext,
  companyId: string,
  id: string,
  mutate: (record: EscalationRecord) => void | false | Promise<void | false>,
): Promise<EscalationRecord | null> {
  const next = await mutateEscalation(ctx, companyId, id, mutate);
  if (next) await syncPending(ctx, next);
  return next;
}

async function publishDocuments(ctx: PluginContext, record: EscalationRecord): Promise<void> {
  if (!record.issueId) return;
  const body = [
    `# Escalation ${record.id}`,
    `Status: ${record.status}`,
    record.failureNote ? `Note: ${record.failureNote}` : "",
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

function armTimeout(ctx: PluginContext, record: EscalationRecord, deps: PipelineDeps, timeoutSec: number): void {
  if (timeoutSec <= 0 || timeoutArmed.has(record.id)) return;
  if (!record.proposals.some((proposal) => proposal.status === "pending") && !record.proposalDeadlineAt) return;
  timeoutArmed.add(record.id);
  const waitMs = record.proposalDeadlineAt
    ? Math.max(0, Date.parse(record.proposalDeadlineAt) - Date.parse(deps.now()))
    : timeoutSec * 1000;
  void deps.schedule(waitMs, () => {
    timeoutArmed.delete(record.id);
    return expirePending(ctx, record.companyId, record.id, deps);
  });
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

async function isolationVerdict(deps: PipelineDeps, proposal: ProposalSlot, activity: RunActivity) {
  if (
    proposal.worktreePath
    && activity.executionCwd
    && !samePath(activity.executionCwd, proposal.worktreePath)
  ) {
    return { dirty: true, error: "Proposal ran outside the isolated worktree" };
  }
  if (!proposal.worktreePath) return { dirty: true, error: "Proposal worktree is missing" };
  const current = await deps.readPorcelain(proposal.worktreePath);
  const head = await deps.readHead(proposal.worktreePath);
  return proposalChangedIsolation({
    baselineHead: proposal.baselineHead,
    baselinePorcelain: proposal.baselinePorcelain,
    currentHead: head.ok ? head.head : null,
    current,
    headError: head.ok ? null : head.error,
  });
}

async function applyProposal(ctx: PluginContext, activity: RunActivity, deps: PipelineDeps): Promise<void> {
  const loaded = await loadEscalationByProposalRun(ctx, activity.companyId, activity.runId);
  if (!loaded) return;
  const removals: string[] = [];
  let source: string | null = loaded.cwd;
  const before = loaded.version ?? 0;
  const updated = await updateRecord(ctx, loaded.companyId, loaded.id, async (record) => {
    const proposal = record.proposals.find((entry) => entry.runId === activity.runId);
    if (!proposal || proposal.status !== "pending") return false;
    source = record.cwd;
    if (activity.eventType === "agent.run.cancelled" || activity.eventType === "agent.run.failed") {
      proposal.status = "failed";
      proposal.error = activity.error ?? activity.status;
    } else {
      const dirty = await isolationVerdict(deps, proposal, activity);
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
    }
    if (proposal.worktreePath) {
      removals.push(proposal.worktreePath);
      proposal.worktreePath = null;
    }
    record.updatedAt = deps.now();
  });
  for (const worktreePath of removals) {
    try {
      await deps.removeProposalWorktree(source, worktreePath);
    } catch (error) {
      ctx.logger.warn("Could not remove proposal worktree", {
        escalationId: loaded.id,
        worktreePath,
        message: error instanceof Error ? error.message : "cleanup failed",
      });
    }
  }
  if (updated && (updated.version ?? 0) !== before && !fanoutOpen.has(loaded.id)) {
    await finalize(ctx, loaded.companyId, loaded.id, deps);
  }
}

async function ingestProposal(ctx: PluginContext, activity: RunActivity, deps: PipelineDeps): Promise<void> {
  const linked = await withRecordLock(`run:${activity.runId}`, async () => {
    let record = await loadEscalationByProposalRun(ctx, activity.companyId, activity.runId);
    if (!record) {
      await saveEarlyProposal(ctx, activity);
      record = await loadEscalationByProposalRun(ctx, activity.companyId, activity.runId);
      if (!record) return false;
      await takeEarlyProposal(ctx, activity.runId);
    }
    return true;
  });
  if (linked) await applyProposal(ctx, activity, deps);
}

async function deliver(ctx: PluginContext, companyId: string, id: string, deps: PipelineDeps): Promise<void> {
  if (delivering.has(id)) return;
  delivering.add(id);
  let retryIn: number | null = null;
  try {
    const record = await loadEscalation(ctx, companyId, id);
    if (!record) return;
    const retryable = record.status === "failed" && record.delivery?.retryable === true;
    if (record.status !== "judging" && !retryable) return;
    const config = await loadConfig(ctx);
    const ready = record.proposals.filter((proposal) => proposal.status === "ready" && proposal.text);
    try {
      if (ready.length === 0) {
        await updateRecord(ctx, companyId, id, (current) => {
          current.status = "failed";
          current.failureNote = current.failureNote && !current.failureNote.startsWith("Delivery failed")
            ? current.failureNote
            : "Every proposal was discarded or failed. Nothing was sent to the judge.";
          current.updatedAt = deps.now();
        });
      } else if (!record.judge) {
        const judged = await deps.judge(record, config.judgeModel);
        await updateRecord(ctx, companyId, id, (current) => {
          current.judge = { model: config.judgeModel, decision: judged.decision, reason: judged.reason };
          current.status = "judging";
          current.updatedAt = deps.now();
        });
      }
      const latest = await loadEscalation(ctx, companyId, id);
      if (!latest) return;
      const posted = await deps.postSlack(latest);
      const saved = await updateRecord(ctx, companyId, id, (current) => {
        current.slack = posted;
        current.status = current.judge ? "awaiting_approval" : "failed";
        current.delivery = null;
        current.updatedAt = deps.now();
      });
      if (saved) await publishDocuments(ctx, saved);
    } catch (error) {
      const message = error instanceof Error ? error.message : "delivery failed";
      const attempt = (record.delivery?.attempt ?? 0) + 1;
      const terminal = attempt >= DELIVERY_MAX_ATTEMPTS;
      const phase = record.judge || ready.length === 0 ? "slack" : "judge";
      await updateRecord(ctx, companyId, id, (current) => {
        current.status = "failed";
        current.failureNote = terminal
          ? `Delivery failed: ${message}`
          : `Delivery failed (attempt ${attempt}/${DELIVERY_MAX_ATTEMPTS}): ${message}`;
        current.delivery = { phase, attempt, retryable: !terminal, lastError: message };
        current.updatedAt = deps.now();
      });
      const visible = await loadEscalation(ctx, companyId, id);
      if (visible) await publishDocuments(ctx, visible);
      if (!terminal) retryIn = backoffMs(attempt);
    }
  } finally {
    delivering.delete(id);
  }
  if (retryIn != null) {
    await deps.schedule(retryIn, () => deliver(ctx, companyId, id, deps));
  }
}

async function finalize(ctx: PluginContext, companyId: string, id: string, deps: PipelineDeps): Promise<void> {
  const next = await updateRecord(ctx, companyId, id, (record) => {
    if (record.proposals.some((proposal) => proposal.status === "pending")) return false;
    if (record.status !== "fanning_out") return false;
    record.status = "judging";
    record.updatedAt = deps.now();
  });
  if (!next || next.status !== "judging") return;
  await deliver(ctx, companyId, id, deps);
}

async function expirePending(ctx: PluginContext, companyId: string, id: string, deps: PipelineDeps): Promise<void> {
  const loaded = await loadEscalation(ctx, companyId, id);
  if (!loaded) return;
  const removals: string[] = [];
  const before = loaded.version ?? 0;
  const updated = await updateRecord(ctx, companyId, id, (record) => {
    let any = false;
    for (const proposal of record.proposals) {
      if (proposal.status !== "pending") continue;
      proposal.status = "failed";
      proposal.error = "Proposal timed out";
      if (proposal.worktreePath) {
        removals.push(proposal.worktreePath);
        proposal.worktreePath = null;
      }
      any = true;
    }
    if (!any) return false;
    record.proposalDeadlineAt = null;
    record.updatedAt = deps.now();
  });
  for (const worktreePath of removals) {
    try {
      await deps.removeProposalWorktree(loaded.cwd, worktreePath);
    } catch (error) {
      ctx.logger.warn("Could not remove proposal worktree", {
        escalationId: id,
        worktreePath,
        message: error instanceof Error ? error.message : "cleanup failed",
      });
    }
  }
  if (updated && (updated.version ?? 0) !== before && !fanoutOpen.has(id)) {
    await finalize(ctx, companyId, id, deps);
  }
}

export async function resumeEscalations(
  ctx: PluginContext,
  deps: PipelineDeps = resolveDeps(ctx),
  companyId?: string,
): Promise<void> {
  const config = await loadConfig(ctx);
  if (!config.enabled) return;
  const pending = await listPendingDeliveries(ctx);
  for (const ref of pending) {
    if (companyId && ref.companyId !== companyId) continue;
    if (!companyAllowed(config, ref.companyId)) continue;
    const record = await loadEscalation(ctx, ref.companyId, ref.id);
    if (!record) {
      await rememberPendingDelivery(ctx, ref.companyId, ref.id, false);
      continue;
    }
    if (record.proposals.some((proposal) => proposal.status === "pending")) {
      if (record.proposalDeadlineAt && Date.parse(record.proposalDeadlineAt) <= Date.parse(deps.now())) {
        await expirePending(ctx, ref.companyId, ref.id, deps);
      } else {
        armTimeout(ctx, record, deps, config.proposalTimeoutSec);
      }
    }
    const fresh = await loadEscalation(ctx, ref.companyId, ref.id);
    if (!fresh) continue;
    if (fanoutReadyToJudge(fresh) && !fanoutOpen.has(fresh.id)) {
      await finalize(ctx, ref.companyId, ref.id, deps);
      continue;
    }
    if (fresh.status === "judging" || (fresh.status === "failed" && fresh.delivery?.retryable)) {
      await deliver(ctx, ref.companyId, ref.id, deps);
    }
  }
}

export async function handleRunEvent(ctx: PluginContext, event: PluginEvent, deps: PipelineDeps = resolveDeps(ctx)): Promise<void> {
  const config = await loadConfig(ctx);
  if (!config.enabled) return;
  const activity = parseRunActivity(event);
  if (activity && !companyAllowed(config, activity.companyId)) return;
  await resumeEscalations(ctx, deps, activity?.companyId);
  if (!activity) return;

  // Proposal wakes are ingested. They must not start another escalation.
  // Ordinary wake reasons (issue_assigned, issue_commented, and so on) still escalate.
  // The failed assignee stays in harnessAgents and is not skipped by agent id.
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
  const config = await loadConfig(ctx);
  const failedHarness = resolveFailedHarness({
    adapterType: failure.adapterType,
    agentId: failure.agentId,
    harnessAgents: config.harnessAgents,
    order: config.harnessOrder,
  });
  const candidates = selectNextHarnesses(failedHarness, config.harnessOrder, config.fanoutCount);
  const now = deps.now();
  const record: EscalationRecord = {
    id: randomUUID(),
    companyId: failure.companyId,
    issueId: failure.issueId,
    failedRunId: failure.runId,
    failedAgentId: failure.agentId,
    failedAdapterType: failedHarness,
    error: failure.error,
    errorCode: failure.errorCode,
    stdoutExcerpt: failure.stdoutExcerpt,
    stderrExcerpt: failure.stderrExcerpt,
    repoUrl: failure.repoUrl,
    repoRef: failure.repoRef,
    branchName: failure.branchName,
    cwd: failure.cwd,
    baselinePorcelain: null,
    candidates,
    proposals: [],
    judge: null,
    status: "fanning_out",
    slack: null,
    decision: null,
    failureNote: null,
    version: 1,
    delivery: null,
    proposalDeadlineAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveEscalation(ctx, record);
  await syncPending(ctx, record);
  fanoutOpen.add(record.id);
  const failureForPrompt: RunActivity = { ...failure, adapterType: failedHarness };
  let timeoutArmedForRecord = false;

  try {
  for (const harness of candidates) {
    const agentId = config.harnessAgents[harness as keyof typeof config.harnessAgents] ?? "";
    if (!agentId) {
      await updateRecord(ctx, record.companyId, record.id, (current) => {
        current.proposals.push(slot(harness, null, "failed", "Proposal agent is not configured"));
        current.updatedAt = deps.now();
      });
      continue;
    }
    if (!failure.cwd) {
      await updateRecord(ctx, record.companyId, record.id, (current) => {
        current.proposals.push(slot(harness, agentId, "failed", "No workspace cwd; proposal was not started"));
        current.updatedAt = deps.now();
      });
      continue;
    }
    const tree = await deps.createProposalWorktree(failure.cwd);
    if (!tree.ok) {
      await updateRecord(ctx, record.companyId, record.id, (current) => {
        current.proposals.push(slot(harness, agentId, "failed", tree.error));
        current.updatedAt = deps.now();
      });
      continue;
    }
    let invoked: { runId: string };
    try {
      invoked = await ctx.agents.invoke(agentId, failure.companyId, {
        prompt: buildProposalPrompt(failureForPrompt, harness),
        reason: PROPOSAL_WAKE_REASON,
        taskKey: `error-escalation:${record.id}:${harness}`,
        escalationCwd: tree.path,
      });
    } catch (error) {
      await deps.removeProposalWorktree(failure.cwd, tree.path);
      await updateRecord(ctx, record.companyId, record.id, (current) => {
        current.proposals.push(slot(
          harness,
          agentId,
          "failed",
          error instanceof Error ? error.message : "invoke failed",
        ));
        current.updatedAt = deps.now();
      });
      continue;
    }
    let early: RunActivity | null = null;
    await withRecordLock(`run:${invoked.runId}`, async () => {
      await updateRecord(ctx, record.companyId, record.id, (current) => {
        current.proposals.push({
          ...slot(harness, agentId, "pending", null),
          runId: invoked.runId,
          worktreePath: tree.path,
          baselineHead: tree.head,
          baselinePorcelain: tree.porcelain,
        });
        if (config.proposalTimeoutSec > 0 && !current.proposalDeadlineAt) {
          const deadline = Date.parse(deps.now()) + config.proposalTimeoutSec * 1000;
          if (Number.isFinite(deadline)) current.proposalDeadlineAt = new Date(deadline).toISOString();
        }
        current.updatedAt = deps.now();
      });
      early = await takeEarlyProposal<RunActivity>(ctx, invoked.runId);
    });
    if (!timeoutArmedForRecord && config.proposalTimeoutSec > 0) {
      timeoutArmedForRecord = true;
      const saved = await loadEscalation(ctx, record.companyId, record.id);
      if (saved) armTimeout(ctx, saved, deps, config.proposalTimeoutSec);
    }
    if (early) await applyProposal(ctx, early, deps);
  }
  } finally {
    fanoutOpen.delete(record.id);
  }
  await finalize(ctx, record.companyId, record.id, deps);
}

function decisionMatches(record: EscalationRecord, channelId: string, messageTs: string, approverUserId: string, actorId: string): string | null {
  if (!record.slack) return "Escalation has no Slack message";
  if (record.slack.channel !== channelId || record.slack.ts !== messageTs) return "Slack channel or timestamp does not match";
  if (!approverUserId.trim()) return "approver is not configured";
  if (actorId !== approverUserId) return "Only the configured approver can decide";
  return null;
}

export async function applySlackIntent(ctx: PluginContext, intent: SlackIntent, deps: PipelineDeps = resolveDeps(ctx)): Promise<{ applied: boolean; reason?: string }> {
  const config = await loadConfig(ctx);
  if (intent.type === "ignore") return { applied: false, reason: "ignored" };
  if (!config.slackApproverUserId.trim()) {
    return { applied: false, reason: "approver is not configured" };
  }

  if (intent.type === "open_reject_modal") {
    if (config.slackChannelId && intent.channelId !== config.slackChannelId) {
      return { applied: false, reason: "channel mismatch" };
    }
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

  let outcome: "approved" | "rejected" | null = null;
  let reason: string | null = null;
  let actorId = "";
  let channelId = "";
  let messageTs = "";
  let escalationId = "";

  if (intent.type === "approve" || intent.type === "reject") {
    outcome = intent.type === "approve" ? "approved" : "rejected";
    reason = intent.reason;
    actorId = intent.userId;
    channelId = intent.channelId;
    messageTs = intent.messageTs;
    escalationId = intent.escalationId;
  } else if (intent.type === "thread_reply") {
    channelId = intent.channelId;
    messageTs = intent.threadTs;
    actorId = intent.userId;
    outcome = intent.outcome;
    reason = intent.reason;
  }

  if (config.slackChannelId && channelId !== config.slackChannelId) {
    return { applied: false, reason: "channel mismatch" };
  }
  const record = escalationId
    ? await findEscalationById(ctx, escalationId)
    : await findEscalationBySlackMessage(ctx, channelId, messageTs);
  if (!record || !outcome) return { applied: false, reason: "missing" };
  const mismatch = decisionMatches(record, channelId, messageTs, config.slackApproverUserId, actorId);
  if (mismatch) {
    if (mismatch.startsWith("Only the configured")) {
      await deps.postEphemeral({ channel: channelId, user: actorId, text: "Only Dan can decide this escalation." });
    }
    return { applied: false, reason: mismatch };
  }

  let applied = false;
  let failure = "already decided";
  const saved = await updateRecord(ctx, record.companyId, record.id, (current) => {
    const currentMismatch = decisionMatches(current, channelId, messageTs, config.slackApproverUserId, actorId);
    if (currentMismatch) {
      failure = currentMismatch;
      return false;
    }
    if (current.status !== "awaiting_approval") {
      failure = "already decided";
      return false;
    }
    current.status = outcome;
    current.decision = { outcome, actorId, reason, at: deps.now() };
    current.updatedAt = deps.now();
    applied = true;
  });
  if (!applied || !saved) return { applied: false, reason: failure };
  await noteApplyFlags(ctx);
  await deps.updateSlack(saved);
  await comment(
    ctx,
    saved,
    outcome === "approved"
      ? `Dan approved escalation ${saved.id}. Nothing was written.`
      : `Dan rejected escalation ${saved.id}.${reason ? ` Reason: ${reason}` : ""}`,
  );
  return { applied: true };
}

export async function handleSlackEnvelope(ctx: PluginContext, envelope: unknown, deps: PipelineDeps = resolveDeps(ctx)): Promise<void> {
  await applySlackIntent(ctx, parseSlackEnvelope(envelope), deps);
}

export { parseSlackEnvelope };
