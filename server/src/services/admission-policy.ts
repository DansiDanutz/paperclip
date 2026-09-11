/**
 * Typed failover admission policy. Every identity binding and numeric bound is
 * an approved-policy input; nothing here defaults to a permissive value. An
 * absent, disabled, or invalid document resolves to admission_not_configured —
 * the fixed refusal condition — never to default-healthy or default-admitted.
 */
export type FailoverPolicyDocument = {
  revision: number;
  enabled: true;
  standbyInstanceId: string;
  primaryInstanceId: string;
  trustedObserverKeys: string[];
  health: {
    maxObservationAgeMs: number;
    maxFutureSkewMs: number;
    consecutiveUnavailableSamples: number;
    unknownBreaksUnhealthySequence: boolean;
  };
  epoch: { ttlMs: number; renewalCadenceMs: number; maxDispatchesPerEpoch: number };
  staleRecovery: {
    enabled: boolean;
    heartbeatIntervalMs: number;
    /** Approved governance anchor: strictly beyond 2× the heartbeat interval. */
    anchorMultiplier: 2;
    pauseHoldRequired: boolean;
    respectScheduledRetries: boolean;
  };
};

export type ResolvedAdmissionPolicy =
  | { state: "configured"; policy: FailoverPolicyDocument; policyRevision: string }
  | { state: "admission_not_configured"; reason: string };

export type AdmissionPolicyRow = {
  policy: unknown;
  policyRevision: string;
  enabled: string | boolean;
};

export type PrimaryHealthState = "healthy" | "unavailable" | "unknown";

export type HealthObservation = { observedAt: Date | string; state: "healthy" | "unavailable" };

const notConfigured = (reason: string): ResolvedAdmissionPolicy => ({
  state: "admission_not_configured",
  reason,
});

const isPositiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function parseHealth(value: unknown): FailoverPolicyDocument["health"] | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    !isPositiveNumber(record.maxObservationAgeMs) ||
    !isPositiveNumber(record.maxFutureSkewMs) ||
    !isPositiveNumber(record.consecutiveUnavailableSamples) ||
    typeof record.unknownBreaksUnhealthySequence !== "boolean"
  ) return null;
  return {
    maxObservationAgeMs: record.maxObservationAgeMs,
    maxFutureSkewMs: record.maxFutureSkewMs,
    consecutiveUnavailableSamples: record.consecutiveUnavailableSamples,
    unknownBreaksUnhealthySequence: record.unknownBreaksUnhealthySequence,
  };
}

function parseEpoch(value: unknown): FailoverPolicyDocument["epoch"] | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    !isPositiveNumber(record.ttlMs) ||
    !isPositiveNumber(record.renewalCadenceMs) ||
    !isPositiveNumber(record.maxDispatchesPerEpoch) ||
    (record.ttlMs as number) < (record.renewalCadenceMs as number) * 2
  ) return null;
  return {
    ttlMs: record.ttlMs,
    renewalCadenceMs: record.renewalCadenceMs,
    maxDispatchesPerEpoch: record.maxDispatchesPerEpoch,
  };
}

function parseStaleRecovery(value: unknown): FailoverPolicyDocument["staleRecovery"] | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    !isPositiveNumber(record.heartbeatIntervalMs) ||
    record.anchorMultiplier !== 2 ||
    typeof record.pauseHoldRequired !== "boolean" ||
    typeof record.respectScheduledRetries !== "boolean" ||
    typeof record.enabled !== "boolean"
  ) return null;
  return {
    enabled: record.enabled,
    heartbeatIntervalMs: record.heartbeatIntervalMs,
    anchorMultiplier: 2,
    pauseHoldRequired: record.pauseHoldRequired,
    respectScheduledRetries: record.respectScheduledRetries,
  };
}

export function resolveAdmissionPolicy(row: AdmissionPolicyRow): ResolvedAdmissionPolicy {
  const enabled = row.enabled === true || row.enabled === "true";
  if (!enabled) return notConfigured("failover admission disabled by policy");
  const document = asRecord(row.policy);
  if (!document) return notConfigured("policy document missing");
  if (!isPositiveNumber(document.revision)) return notConfigured("policy revision missing");
  if (!isNonEmptyString(document.standbyInstanceId)) return notConfigured("standby identity unbound");
  if (!isNonEmptyString(document.primaryInstanceId)) return notConfigured("primary identity unbound");
  if (!Array.isArray(document.trustedObserverKeys) || document.trustedObserverKeys.length === 0) {
    return notConfigured("no trusted health observers bound");
  }
  const health = parseHealth(document.health);
  if (!health) return notConfigured("health observation policy incomplete");
  const epoch = parseEpoch(document.epoch);
  if (!epoch) return notConfigured("epoch operating limits incomplete");
  const staleRecovery = parseStaleRecovery(document.staleRecovery);
  if (!staleRecovery) return notConfigured("stale recovery governance incomplete");
  const policy: FailoverPolicyDocument = {
    revision: document.revision,
    enabled: true,
    standbyInstanceId: document.standbyInstanceId,
    primaryInstanceId: document.primaryInstanceId,
    trustedObserverKeys: document.trustedObserverKeys.filter(isNonEmptyString),
    health,
    epoch,
    staleRecovery,
  };
  if (policy.trustedObserverKeys.length === 0) return notConfigured("no trusted health observers bound");
  return {
    state: "configured",
    policy,
    policyRevision: row.policyRevision,
  };
}

/**
 * Deterministic primary-health decision under the observation policy. Unknown
 * is its own state and never means down: observations outside the age/skew
 * window are ignored, and "unavailable" requires the configured consecutive
 * unavailable samples inside the window.
 */
export function evaluatePrimaryHealth(
  samples: HealthObservation[],
  policy: FailoverPolicyDocument,
  now: Date,
): PrimaryHealthState {
  const health = policy.health;
  const nowMs = now.getTime();
  const inWindow = samples
    .map((sample) => ({ time: new Date(sample.observedAt).getTime(), state: sample.state }))
    .filter((sample) =>
      Number.isFinite(sample.time) &&
      sample.time >= nowMs - health.maxObservationAgeMs &&
      sample.time <= nowMs + health.maxFutureSkewMs)
    .sort((left, right) => right.time - left.time);

  if (inWindow.length === 0) return "unknown";

  let unavailableRun = 0;
  for (const sample of inWindow) {
    if (sample.state !== "unavailable") return "healthy";
    unavailableRun += 1;
    if (unavailableRun >= health.consecutiveUnavailableSamples) return "unavailable";
  }
  return "unknown";
}
