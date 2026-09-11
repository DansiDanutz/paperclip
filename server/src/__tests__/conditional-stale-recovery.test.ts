import { describe, expect, it } from "vitest";
import { selectStaleRecoveryCandidates } from "../services/conditional-stale-recovery.js";

const policy = {
  revision: 1,
  enabled: true,
  standbyInstanceId: "instance-standby",
  primaryInstanceId: "instance-primary",
  trustedObserverKeys: ["observer-key-1"],
  health: {
    maxObservationAgeMs: 60_000,
    maxFutureSkewMs: 5_000,
    consecutiveUnavailableSamples: 2,
    unknownBreaksUnhealthySequence: true,
  },
  epoch: { ttlMs: 60_000, renewalCadenceMs: 10_000, maxDispatchesPerEpoch: 500 },
  staleRecovery: {
    enabled: true,
    heartbeatIntervalMs: 60_000,
    anchorMultiplier: 2,
    pauseHoldRequired: true,
    respectScheduledRetries: true,
  },
};

const baseCandidate = {
  issueId: "issue-1",
  status: "in_progress" as const,
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  hasLiveRun: false,
  hasExternalBlocker: false,
  isScheduledRetryWait: false,
  hasPauseHold: false,
  hasCompleteGovernance: true,
  lastActivityAt: new Date("2026-09-10T11:00:00Z"),
};

const now = new Date("2026-09-10T12:30:00Z");

describe("conditional stale-task recovery governance", () => {
  it("selects an assigned agent issue strictly beyond the 2× heartbeat anchor", () => {
    const candidates = selectStaleRecoveryCandidates({ policy, now, issues: [baseCandidate] });
    expect(candidates.map((candidate) => candidate.issueId)).toEqual(["issue-1"]);
  });

  it("never selects work at or inside the 2× anchor", () => {
    const inside = { ...baseCandidate, lastActivityAt: new Date(now.getTime() - 60_000) };
    const exactly = { ...baseCandidate, lastActivityAt: new Date(now.getTime() - 120_000) };
    expect(selectStaleRecoveryCandidates({ policy, now, issues: [inside, exactly] })).toEqual([]);
  });

  it.each([
    ["a human assignee", { assigneeUserId: "human", assigneeAgentId: null }],
    ["an unowned issue", { assigneeAgentId: null }],
    ["a live run", { hasLiveRun: true }],
    ["an external blocker", { hasExternalBlocker: true }],
    ["a scheduled-retry wait", { isScheduledRetryWait: true }],
    ["a required pause hold", { hasPauseHold: true }],
    ["incomplete governance", { hasCompleteGovernance: false }],
    ["a terminal status", { status: "done" as const }],
  ])("excludes %s", (_label, patch) => {
    const candidates = selectStaleRecoveryCandidates({ policy, now, issues: [{ ...baseCandidate, ...patch }] });
    expect(candidates).toEqual([]);
  });

  it("treats scheduled-retry waits as candidates only when the policy stops respecting them", () => {
    const retryWait = { ...baseCandidate, isScheduledRetryWait: true };
    expect(selectStaleRecoveryCandidates({ policy, now, issues: [retryWait] })).toEqual([]);
    const relaxed = {
      ...policy,
      staleRecovery: { ...policy.staleRecovery, respectScheduledRetries: false },
    };
    expect(selectStaleRecoveryCandidates({ policy: relaxed, now, issues: [retryWait] }))
      .toEqual([{ issueId: "issue-1", reason: expect.any(String) }]);
  });

  it("selects nothing at all while stale recovery is disabled in policy", () => {
    const disabled = {
      ...policy,
      staleRecovery: { ...policy.staleRecovery, enabled: false },
    };
    expect(selectStaleRecoveryCandidates({ policy: disabled, now, issues: [baseCandidate] })).toEqual([]);
  });
});
