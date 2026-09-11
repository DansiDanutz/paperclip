import type { FailoverPolicyDocument } from "./admission-policy.js";

export type StaleRecoveryPolicy = NonNullable<FailoverPolicyDocument["staleRecovery"]>;

export type StaleCandidateRow = {
  issueId: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  hasLiveRun: boolean;
  hasExternalBlocker: boolean;
  isScheduledRetryWait: boolean;
  hasPauseHold: boolean;
  hasCompleteGovernance: boolean;
  lastActivityAt: Date;
};

export type StaleRecoveryDecision = { issueId: string; reason: string };

/**
 * Governed conditional stale-task recovery evaluator. Pure decision layer over
 * the approved semantics: an assigned agent issue is stale strictly beyond
 * anchorMultiplier × the heartbeat interval, and every governance precondition
 * (no live run, no external blocker, scheduled-retry waits respected, pause
 * hold honored, complete owner/reviewer/goal state) must hold. A disabled or
 * incomplete policy selects nothing; execution itself is separately gated by
 * admission and reuses the native recovery primitives.
 */
export function selectStaleRecoveryCandidates(input: {
  policy: FailoverPolicyDocument;
  now: Date;
  issues: StaleCandidateRow[];
}): StaleRecoveryDecision[] {
  const stale = input.policy.staleRecovery;
  if (!stale?.enabled) return [];

  const cutoff = input.now.getTime() - stale.anchorMultiplier * stale.heartbeatIntervalMs;
  const decisions: StaleRecoveryDecision[] = [];
  for (const row of input.issues) {
    if (row.status !== "todo" && row.status !== "in_progress") continue;
    if (!row.assigneeAgentId || row.assigneeUserId) continue;
    if (row.hasLiveRun || row.hasExternalBlocker) continue;
    if (row.isScheduledRetryWait && stale.respectScheduledRetries) continue;
    if (stale.pauseHoldRequired && row.hasPauseHold) continue;
    if (!row.hasCompleteGovernance) continue;
    if (row.lastActivityAt.getTime() >= cutoff) continue;
    decisions.push({
      issueId: row.issueId,
      reason: `stale beyond ${stale.anchorMultiplier}× heartbeat interval`,
    });
  }
  return decisions;
}
