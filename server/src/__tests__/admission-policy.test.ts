import { describe, expect, it } from "vitest";
import {
  evaluatePrimaryHealth,
  resolveAdmissionPolicy,
} from "../services/admission-policy.js";

const validDocument = {
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
    enabled: false,
    heartbeatIntervalMs: 60_000,
    anchorMultiplier: 2,
    pauseHoldRequired: true,
    respectScheduledRetries: true,
  },
};

describe("failover admission policy resolution", () => {
  const resolve = (doc: unknown, enabled = "true", revision = "r1") =>
    resolveAdmissionPolicy({ policy: doc, enabled, policyRevision: revision });

  it("accepts a complete enabled document", () => {
    const resolved = resolve(validDocument);
    expect(resolved).toMatchObject({ state: "configured" });
  });

  it.each([
    ["missing document", null, "empty document"],
    ["non-object document", "nope", "empty document"],
  ])("refuses %s", (_label, doc, _reason) => {
    expect(resolve(doc).state).toBe("admission_not_configured");
  });

  it("refuses a disabled policy", () => {
    expect(resolve({ ...validDocument, enabled: false }, "false").state).toBe("admission_not_configured");
    expect(resolve({ ...validDocument, enabled: true }, "false").state).toBe("admission_not_configured");
  });

  it("refuses an enabled policy missing any required binding or bound", () => {
    for (const patch of [
      { standbyInstanceId: null },
      { primaryInstanceId: "" },
      { trustedObserverKeys: [] },
      { health: null },
      { health: { ...validDocument.health, maxObservationAgeMs: -1 } },
      { health: { ...validDocument.health, consecutiveUnavailableSamples: 0 } },
      { epoch: null },
      { epoch: { ...validDocument.epoch, renewalCadenceMs: 60_000 } },
      { epoch: { ...validDocument.epoch, maxDispatchesPerEpoch: 0 } },
      { staleRecovery: { ...validDocument.staleRecovery, anchorMultiplier: 3 } },
      { staleRecovery: { ...validDocument.staleRecovery, heartbeatIntervalMs: 0 } },
    ]) {
      expect(resolve({ ...validDocument, ...patch }).state).toBe("admission_not_configured");
    }
  });

  it("binds the approved stale anchor multiplier at exactly 2", () => {
    expect(resolve({ ...validDocument, staleRecovery: { ...validDocument.staleRecovery, anchorMultiplier: 2 } }))
      .toMatchObject({ state: "configured" });
  });
});

describe("primary health evaluation under policy", () => {
  const now = new Date("2026-09-10T12:00:00Z");
  const sample = (secondsAgo: number, state: "healthy" | "unavailable") => ({
    observedAt: new Date(now.getTime() - secondsAgo * 1000),
    state,
  });
  const health = validDocument.health!;

  it("reports healthy on a fresh healthy observation", () => {
    expect(evaluatePrimaryHealth([sample(5, "healthy")], { ...validDocument, health }, now)).toBe("healthy");
  });

  it("reports unavailable after the configured consecutive unavailable samples", () => {
    expect(evaluatePrimaryHealth(
      [sample(5, "unavailable"), sample(35, "unavailable")],
      { ...validDocument, health }, now,
    )).toBe("unavailable");
  });

  it("stays unknown below the consecutive threshold", () => {
    expect(evaluatePrimaryHealth([sample(5, "unavailable")], { ...validDocument, health }, now)).toBe("unknown");
  });

  it("ignores observations older than the configured maximum age", () => {
    expect(evaluatePrimaryHealth([sample(600, "unavailable"), sample(590, "unavailable")], { ...validDocument, health }, now))
      .toBe("unknown");
  });

  it("ignores observations beyond the permitted future skew", () => {
    const future = { observedAt: new Date(now.getTime() + 60_000), state: "healthy" as const };
    expect(evaluatePrimaryHealth([future], { ...validDocument, health }, now)).toBe("unknown");
  });
});
