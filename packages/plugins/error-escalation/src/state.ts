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
  createdAt: string;
  updatedAt: string;
}

function scope(companyId: string, stateKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey };
}

export async function saveEscalation(ctx: PluginContext, record: EscalationRecord): Promise<void> {
  await ctx.state.set(scope(record.companyId, `escalation:${record.id}`), record);
  await ctx.state.set({ scopeKind: "instance", stateKey: `id:${record.id}` }, record.companyId);
  await ctx.state.set(scope(record.companyId, `by-run:${record.failedRunId}`), record.id);
  if (record.issueId) {
    const key = scope(record.companyId, `issue:${record.issueId}`);
    const existing = await ctx.state.get(key);
    const ids = Array.isArray(existing) ? existing.filter((entry): entry is string => typeof entry === "string") : [];
    if (!ids.includes(record.id)) {
      ids.push(record.id);
      await ctx.state.set(key, ids);
    }
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
