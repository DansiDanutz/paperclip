import { PROPOSAL_WAKE_REASON } from "./constants.js";

export interface RunActivity {
  companyId: string;
  runId: string;
  agentId: string;
  adapterType: string;
  status: string;
  error: string | null;
  errorCode: string | null;
  exitCode: number | null;
  issueId: string | null;
  wakeReason: string | null;
  escalationProposal: boolean;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  branchName: string | null;
  cwd: string | null;
  eventType: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseRunActivity(event: {
  companyId?: string;
  eventType?: string;
  payload?: unknown;
}): RunActivity | null {
  const payload = event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
  const runId = text(payload.runId);
  const agentId = text(payload.agentId);
  const companyId = text(event.companyId) ?? text(payload.companyId);
  if (!runId || !agentId || !companyId) return null;
  const wakeReason = text(payload.wakeReason);
  return {
    companyId,
    runId,
    agentId,
    adapterType: text(payload.adapterType) ?? "unknown",
    status: text(payload.status) ?? "",
    error: text(payload.error),
    errorCode: text(payload.errorCode),
    exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
    issueId: text(payload.issueId),
    wakeReason,
    escalationProposal: payload.escalationProposal === true || wakeReason === PROPOSAL_WAKE_REASON,
    stdoutExcerpt: typeof payload.stdoutExcerpt === "string" ? payload.stdoutExcerpt : null,
    stderrExcerpt: typeof payload.stderrExcerpt === "string" ? payload.stderrExcerpt : null,
    repoUrl: text(payload.repoUrl),
    repoRef: text(payload.repoRef),
    branchName: text(payload.branchName),
    cwd: text(payload.cwd),
    eventType: event.eventType ?? "",
  };
}

export function buildProposalPrompt(failure: RunActivity, harness: string): string {
  return [
    "You are writing a fix proposal only.",
    "Do not edit files, commit, push, or run commands that change the worktree.",
    "Reply with a unified diff and a short explanation of why it fixes the error.",
    `Harness: ${harness}`,
    `Failed adapter: ${failure.adapterType}`,
    `Failed run: ${failure.runId}`,
    `Issue: ${failure.issueId ?? "none"}`,
    `Repo: ${failure.repoUrl ?? "unknown"}`,
    `Ref: ${failure.repoRef ?? "unknown"}`,
    `Branch: ${failure.branchName ?? "unknown"}`,
    `Workspace: ${failure.cwd ?? "unknown"}`,
    `Error code: ${failure.errorCode ?? "unknown"}`,
    `Exit code: ${failure.exitCode ?? "unknown"}`,
    "Error:",
    failure.error ?? "(no error message)",
    "Last stdout:",
    failure.stdoutExcerpt ?? "(none)",
    "Last stderr:",
    failure.stderrExcerpt ?? "(none)",
    "You are in a throwaway git worktree. Do not try to reach the original checkout.",
    "Read-only CLI flags were confirmed from --help and have not been exercised at runtime. A commit or a worktree change discards the proposal.",
  ].join("\n");
}
