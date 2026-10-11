import type { PluginContext } from "@paperclipai/plugin-sdk";

export type ProposalStatus = "pending" | "ready" | "discarded" | "failed";
export type EscalationStatus =
  | "fanning_out"
  | "judging"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "failed";

export interface ProposalSlot {
  adapterType: string;
  agentId: string | null;
  runId: string | null;
  text: string | null;
  dirty: boolean;
  discarded: boolean;
  discardReason: string | null;
  status: ProposalStatus;
  error: string | null;
  worktreePath: string | null;
  baselineHead: string | null;
  baselinePorcelain: string | null;
  baselineContentHash: string | null;
}

export interface DeliveryState {
  phase: "judge" | "slack";
  attempt: number;
  retryable: boolean;
  lastError: string | null;
}

export interface EscalationDecision {
  outcome: "approved" | "rejected";
  actorId: string;
  reason: string | null;
  at: string;
}

export interface EscalationRecord {
  id: string;
  companyId: string;
  issueId: string | null;
  failedRunId: string;
  failedAgentId: string;
  failedAdapterType: string;
  error: string | null;
  errorCode: string | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  branchName: string | null;
  cwd: string | null;
  baselinePorcelain: string | null;
  candidates: string[];
  proposals: ProposalSlot[];
  judge: { model: string; decision: string; reason: string } | null;
  status: EscalationStatus;
  slack: { channel: string; ts: string } | null;
  decision: EscalationDecision | null;
  failureNote: string | null;
  version: number;
  delivery: DeliveryState | null;
  proposalDeadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function scope(companyId: string, stateKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey };
}

async function rememberIssueEscalation(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  escalationId: string,
): Promise<void> {
  await withRecordLock(`issue:${companyId}:${issueId}`, async () => {
    const key = scope(companyId, `issue:${issueId}`);
    const existing = await ctx.state.get(key);
    const ids = Array.isArray(existing) ? existing.filter((entry): entry is string => typeof entry === "string") : [];
    if (!ids.includes(escalationId)) {
      ids.push(escalationId);
      await ctx.state.set(key, ids);
    }
  });
}

export async function saveEscalation(ctx: PluginContext, record: EscalationRecord): Promise<void> {
  await ctx.state.set(scope(record.companyId, `escalation:${record.id}`), record);
  await ctx.state.set({ scopeKind: "instance", stateKey: `id:${record.id}` }, record.companyId);
  await ctx.state.set(scope(record.companyId, `by-run:${record.failedRunId}`), record.id);
  if (record.issueId) {
    await rememberIssueEscalation(ctx, record.companyId, record.issueId, record.id);
  }
  for (const proposal of record.proposals) {
    if (proposal.runId) {
      await ctx.state.set(scope(record.companyId, `by-proposal-run:${proposal.runId}`), record.id);
    }
  }
  if (record.slack) {
    await ctx.state.set(
      scope(record.companyId, `by-slack:${record.slack.channel}:${record.slack.ts}`),
      record.id,
    );
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `slack:${record.slack.channel}:${record.slack.ts}` },
      { companyId: record.companyId, id: record.id },
    );
  }
}

export async function findEscalationById(ctx: PluginContext, id: string): Promise<EscalationRecord | null> {
  const companyId = await ctx.state.get({ scopeKind: "instance", stateKey: `id:${id}` });
  if (typeof companyId !== "string" || !companyId) return null;
  return loadEscalation(ctx, companyId, id);
}

export async function findEscalationBySlackMessage(
  ctx: PluginContext,
  channel: string,
  ts: string,
): Promise<EscalationRecord | null> {
  const pointer = await ctx.state.get({ scopeKind: "instance", stateKey: `slack:${channel}:${ts}` });
  if (!pointer || typeof pointer !== "object") return null;
  const companyId = (pointer as { companyId?: unknown }).companyId;
  const id = (pointer as { id?: unknown }).id;
  if (typeof companyId !== "string" || typeof id !== "string") return null;
  return loadEscalation(ctx, companyId, id);
}

export async function loadEscalation(ctx: PluginContext, companyId: string, id: string): Promise<EscalationRecord | null> {
  const value = await ctx.state.get(scope(companyId, `escalation:${id}`));
  return value && typeof value === "object" ? (value as EscalationRecord) : null;
}

async function loadId(ctx: PluginContext, companyId: string, stateKey: string): Promise<EscalationRecord | null> {
  const id = await ctx.state.get(scope(companyId, stateKey));
  if (typeof id !== "string" || !id) return null;
  return loadEscalation(ctx, companyId, id);
}

export function loadEscalationByFailedRun(ctx: PluginContext, companyId: string, runId: string) {
  return loadId(ctx, companyId, `by-run:${runId}`);
}

export function loadEscalationByProposalRun(ctx: PluginContext, companyId: string, runId: string) {
  return loadId(ctx, companyId, `by-proposal-run:${runId}`);
}

export function loadEscalationBySlack(ctx: PluginContext, companyId: string, channel: string, ts: string) {
  return loadId(ctx, companyId, `by-slack:${channel}:${ts}`);
}

const locks = new Map<string, Promise<void>>();

export function withRecordLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate, () => gate);
  locks.set(key, tail);
  return previous.then(fn, fn).finally(() => {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  });
}

export async function mutateEscalation(
  ctx: PluginContext,
  companyId: string,
  id: string,
  mutate: (record: EscalationRecord) => void | false | Promise<void | false>,
): Promise<EscalationRecord | null> {
  return withRecordLock(id, async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await loadEscalation(ctx, companyId, id);
      if (!current) return null;
      const version = typeof current.version === "number" ? current.version : 0;
      const next = structuredClone(current);
      next.version = version;
      const changed = await mutate(next);
      if (changed === false) return current;
      const stored = await loadEscalation(ctx, companyId, id);
      const storedVersion = stored && typeof stored.version === "number" ? stored.version : 0;
      if (storedVersion !== version) continue;
      next.version = version + 1;
      await saveEscalation(ctx, next);
      return next;
    }
    throw new Error(`Escalation ${id} changed concurrently`);
  });
}

function earlyKey(runId: string) {
  return { scopeKind: "instance" as const, stateKey: `early-proposal:${runId}` };
}

export async function saveEarlyProposal(ctx: PluginContext, activity: unknown): Promise<void> {
  const runId = activity && typeof activity === "object" && typeof (activity as { runId?: unknown }).runId === "string"
    ? (activity as { runId: string }).runId
    : "";
  if (!runId) return;
  await ctx.state.set(earlyKey(runId), activity);
}

export async function takeEarlyProposal<T>(ctx: PluginContext, runId: string): Promise<T | null> {
  const value = await ctx.state.get(earlyKey(runId));
  if (!value || typeof value !== "object") return null;
  await ctx.state.delete(earlyKey(runId));
  return value as T;
}

const PENDING_DELIVERY = { scopeKind: "instance" as const, stateKey: "pending-delivery" };

export interface PendingDeliveryRef {
  companyId: string;
  id: string;
}

export async function listPendingDeliveries(ctx: PluginContext): Promise<PendingDeliveryRef[]> {
  const value = await ctx.state.get(PENDING_DELIVERY);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PendingDeliveryRef => {
    return Boolean(entry) && typeof entry === "object"
      && typeof (entry as PendingDeliveryRef).companyId === "string"
      && typeof (entry as PendingDeliveryRef).id === "string";
  });
}

export async function rememberPendingDelivery(
  ctx: PluginContext,
  companyId: string,
  id: string,
  active: boolean,
): Promise<void> {
  await withRecordLock("pending-delivery", async () => {
    const current = await listPendingDeliveries(ctx);
    const next = current.filter((entry) => entry.id !== id);
    if (active) next.push({ companyId, id });
    await ctx.state.set(PENDING_DELIVERY, next);
  });
}

export async function listEscalationsForIssue(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<EscalationRecord[]> {
  const ids = await ctx.state.get(scope(companyId, `issue:${issueId}`));
  if (!Array.isArray(ids)) return [];
  const records: EscalationRecord[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const record = await loadEscalation(ctx, companyId, id);
    if (record) records.push(record);
  }
  return records;
}
