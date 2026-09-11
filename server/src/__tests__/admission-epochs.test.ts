import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyDispatchEpochs,
  companyFailoverPolicies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createFailoverAdmissionService } from "../services/admission.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const enabledPolicy = {
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
  epoch: { ttlMs: 60_000, renewalCadenceMs: 10_000, maxDispatchesPerEpoch: 3 },
  staleRecovery: {
    enabled: true,
    heartbeatIntervalMs: 60_000,
    anchorMultiplier: 2,
    pauseHoldRequired: true,
    respectScheduledRetries: true,
  },
};

describeEmbeddedPostgres("company dispatch epoch admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let admission!: ReturnType<typeof createFailoverAdmissionService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-admission-epochs-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyDispatchEpochs);
    await db.delete(companyFailoverPolicies);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPolicy(input?: { enabled?: boolean; doc?: Record<string, unknown> | null }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    if (input?.doc !== null) {
      await db.insert(companyFailoverPolicies).values({
        companyId,
        policy: input?.doc ?? enabledPolicy,
        policyRevision: "test-rev-1",
        enabled: input?.enabled === false ? "false" : "true",
      });
    }
    return { companyId };
  }

  it("refuses admission when the policy is absent, disabled or unhealthy evidence is missing", async () => {
    admission = createFailoverAdmissionService(db);
    const absent = await seedPolicy({ doc: null });
    const disabled = await seedPolicy({ enabled: false });
    const healthy = await seedPolicy();

    for (const companyId of [absent.companyId, disabled.companyId]) {
      const decision = await admission.tryAdmitStandby(companyId, "instance-standby", "unavailable");
      expect(decision).toMatchObject({ admitted: false, code: "admission_not_configured" });
    }
    const decision = await admission.tryAdmitStandby(healthy.companyId, "instance-standby", "healthy");
    expect(decision).toMatchObject({ admitted: false, code: "admission_refused_primary_healthy" });
    const unknown = await admission.tryAdmitStandby(healthy.companyId, "instance-standby", "unknown");
    expect(unknown).toMatchObject({ admitted: false, code: "admission_refused_unknown" });
    expect(await db.select().from(companyDispatchEpochs)).toHaveLength(0);
  });

  it("admits the bound standby when the primary is unavailable and records the epoch", async () => {
    admission = createFailoverAdmissionService(db);
    const { companyId } = await seedPolicy();
    const decision = await admission.tryAdmitStandby(companyId, "instance-standby", "unavailable");
    expect(decision).toMatchObject({ admitted: true, epoch: { dispatchBudgetRemaining: 3 } });
    const rows = await db.select().from(companyDispatchEpochs).where(eq(companyDispatchEpochs.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerInstanceId: "instance-standby",
      state: "active",
      maxDispatches: 3,
      epoch: 1,
    });
  });

  it("admits exactly one epoch when two standbys race for the same company", async () => {
    admission = createFailoverAdmissionService(db);
    const { companyId } = await seedPolicy();
    const [first, second] = await Promise.all([
      admission.tryAdmitStandby(companyId, "instance-standby", "unavailable"),
      admission.tryAdmitStandby(companyId, "instance-standby-2", "unavailable"),
    ]);
    const admitted = [first, second].filter((decision) => decision.admitted);
    expect(admitted).toHaveLength(1);
    const rows = await db.select().from(companyDispatchEpochs).where(eq(companyDispatchEpochs.companyId, companyId));
    expect(rows.filter((row) => row.state === "active")).toHaveLength(1);
  });

  it("exhausts the dispatch budget and refuses further consumption", async () => {
    admission = createFailoverAdmissionService(db);
    const { companyId } = await seedPolicy();
    await admission.tryAdmitStandby(companyId, "instance-standby", "unavailable");
    for (let index = 0; index < 3; index += 1) {
      expect(await admission.consumeDispatchSlot(companyId, "instance-standby")).toBe(true);
    }
    expect(await admission.consumeDispatchSlot(companyId, "instance-standby")).toBe(false);
  });

  it("lets primary recovery invalidate the epoch and refuses the standby afterwards", async () => {
    admission = createFailoverAdmissionService(db);
    const { companyId } = await seedPolicy();
    await admission.tryAdmitStandby(companyId, "instance-standby", "unavailable");
    expect(await admission.invalidateEpoch(companyId, "instance-primary", "primary_recovered")).toBe(true);
    expect(await admission.consumeDispatchSlot(companyId, "instance-standby")).toBe(false);
    const decision = await admission.tryAdmitStandby(companyId, "instance-standby", "unavailable");
    expect(decision).toMatchObject({ admitted: true, epoch: { epochValue: 2 } });
  });

  it("expires an abandoned epoch and admits the next epoch to a new standby", async () => {
    admission = createFailoverAdmissionService(db);
    const { companyId } = await seedPolicy();
    const shortPolicy = {
      ...enabledPolicy,
      epoch: { ttlMs: 50, renewalCadenceMs: 10, maxDispatchesPerEpoch: 3 },
    };
    await db.update(companyFailoverPolicies).set({ policy: shortPolicy }).where(
      eq(companyFailoverPolicies.companyId, companyId),
    );
    await admission.tryAdmitStandby(companyId, "instance-standby", "unavailable");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const decision = await admission.tryAdmitStandby(companyId, "instance-standby", "unavailable");
    expect(decision).toMatchObject({ admitted: true, epoch: { epochValue: 2 } });
    const rows = await db.select().from(companyDispatchEpochs).where(eq(companyDispatchEpochs.companyId, companyId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.epoch === 1)?.state).toBe("expired");
  });

  it("keeps companies isolated: an epoch for one company fences nothing else", async () => {
    admission = createFailoverAdmissionService(db);
    const first = await seedPolicy();
    const second = await seedPolicy();
    await admission.tryAdmitStandby(first.companyId, "instance-standby", "unavailable");
    const decision = await admission.consumeDispatchSlot(second.companyId, "instance-standby");
    expect(decision).toBe(false);
  });
});
