/**
 * Maps a finished heartbeat run to the plugin activity event that observers
 * use. Proposal runs are still reported, with `escalationProposal` set, so a
 * listener can read the excerpt without starting another escalation.
 */

export const ERROR_ESCALATION_PROPOSAL_WAKE_REASON = "error_escalation_proposal";

export const TERMINAL_RUN_ACTIVITY_EXCERPT_CHARS = 4000;

export type TerminalRunActivityAction =
  | "agent.run.finished"
  | "agent.run.failed"
  | "agent.run.cancelled";

export function terminalRunActivityAction(status: string): TerminalRunActivityAction | null {
  if (status === "succeeded") return "agent.run.finished";
  if (status === "failed" || status === "timed_out") return "agent.run.failed";
  if (status === "cancelled") return "agent.run.cancelled";
  return null;
}

/**
 * Publish one activity row for each terminal transition. A second write of the
 * same terminal action (pause already cancelled the run, then the execution
 * path writes cancelled again) must not emit a duplicate.
 */
export function shouldPublishTerminalRunActivity(
  previousStatus: string | null | undefined,
  nextStatus: string,
): boolean {
  const next = terminalRunActivityAction(nextStatus);
  if (!next) return false;
  const previous = previousStatus ? terminalRunActivityAction(previousStatus) : null;
  return previous !== next;
}

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isEscalationProposalWake(context: Record<string, unknown> | null | undefined): boolean {
  return readNonEmptyString(context?.wakeReason) === ERROR_ESCALATION_PROPOSAL_WAKE_REASON;
}

export function truncateActivityExcerpt(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length <= TERMINAL_RUN_ACTIVITY_EXCERPT_CHARS) return value;
  return value.slice(value.length - TERMINAL_RUN_ACTIVITY_EXCERPT_CHARS);
}

export interface TerminalRunActivityDetails {
  runId: string;
  agentId: string;
  adapterType: string | null;
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
}

export function buildTerminalRunActivityDetails(input: {
  runId: string;
  agentId: string;
  adapterType: string | null;
  status: string;
  error: string | null;
  errorCode: string | null;
  exitCode: number | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  contextSnapshot: Record<string, unknown> | null;
}): TerminalRunActivityDetails {
  const context = input.contextSnapshot ?? {};
  const workspace =
    context.paperclipWorkspace && typeof context.paperclipWorkspace === "object"
      ? (context.paperclipWorkspace as Record<string, unknown>)
      : {};
  return {
    runId: input.runId,
    agentId: input.agentId,
    adapterType: input.adapterType,
    status: input.status,
    error: input.error,
    errorCode: input.errorCode,
    exitCode: input.exitCode,
    issueId: readNonEmptyString(context.issueId),
    wakeReason: readNonEmptyString(context.wakeReason),
    escalationProposal: isEscalationProposalWake(context),
    stdoutExcerpt: truncateActivityExcerpt(input.stdoutExcerpt),
    stderrExcerpt: truncateActivityExcerpt(input.stderrExcerpt),
    repoUrl: readNonEmptyString(workspace.repoUrl),
    repoRef: readNonEmptyString(workspace.repoRef),
    branchName: readNonEmptyString(workspace.branchName),
    cwd: readNonEmptyString(workspace.cwd),
  };
}
