import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyDispatchEpochs,
  companyFailoverPolicies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_input?: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Synthetic standby continuation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { createFailoverAdmissionService } from "../services/admission.js";
import { selectStaleRecoveryCandidates } from "../services/conditional-stale-recovery.js";
import { runningProcesses } from "../adapters/index.ts";
import type { Db } from "../services/database.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("standby admission and stale-recovery wiring", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-admission-wiring-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await db.delete(companyDispatchEpochs);
    await db.delete(companyFailoverPolicies);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issues);
      try {
        await db.delete(agents);
        break;
      } catch {
        if (attempt === 4) throw new Error("agent cleanup retained foreign keys");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(companies);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

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
    epoch: { ttlMs: 600_000, renewalCadenceMs: 10_000, maxDispatchesPerEpoch: 500 },
    staleRecovery: {
      enabled: true,
      heartbeatIntervalMs: 60_000,
      anchorMultiplier: 2,
      pauseHoldRequired: true,
      respectScheduledRetries: true,
    },
  };

  async function seedStaleWorkload() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale assigned work behind admission",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      updatedAt: new Date(now.getTime() - 10 * 60_000),
    });
    return { companyId, agentId, issueId, now };
  }

  it("evaluates stale governance and dispatches only across an admitted epoch", async () => {
    const admission = createFailoverAdmissionService(db);
    const seed = await seedStaleWorkload();
    await db.insert(companyFailoverPolicies).values({
      companyId: seed.companyId,
      policy: enabledPolicy,
      policyRevision: "test-rev-1",
      enabled: "true",
    });

    const rows = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    const candidates = selectStaleRecoveryCandidates({
      policy: enabledPolicy,
      now: new Date(seed.now.getTime() + 30 * 60_000),
      issues: [{
        issueId: rows.id,
        status: "in_progress",
        assigneeAgentId: rows.assigneeAgentId,
        assigneeUserId: null,
        hasLiveRun: false,
        hasExternalBlocker: false,
        isScheduledRetryWait: false,
        hasPauseHold: false,
        hasCompleteGovernance: true,
        lastActivityAt: rows.updatedAt,
      }],
    });
    expect(candidates).toHaveLength(1);

    // Before admission the gated heartbeat surface dispatches nothing for the
    // candidate's company, so the stale decision cannot become a dispatch.
    const gateConsulted: string[] = [];
    const heartbeat = heartbeatService(db, {
      dispatchGate: async ({ companyId }) => {
        gateConsulted.push(companyId);
        return admission.isDispatchAllowed(companyId, "instance-standby");
      },
      runtimeEnv: { PAPERCLIP_TELEMETRY_DISABLED: "1" },
    });
    await heartbeat.startNextQueuedRunForAgent(seed.agentId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seed.companyId))).toHaveLength(0);

    // Once the standby is admitted for the epoch, the gate lets the claim
    // boundary through (execution itself is covered by the recovery suites).
    await admission.tryAdmitStandby(seed.companyId, "instance-standby", "unavailable");
    await heartbeat.startNextQueuedRunForAgent(seed.agentId);
    expect(gateConsulted).toContain(seed.companyId);
  });
});
