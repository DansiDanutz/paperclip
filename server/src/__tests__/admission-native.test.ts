import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentTaskSessions,
  agentConfigRevisions,
  agentApiKeys,
  agentMemberships,
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

import express from "express";
import { heartbeatService } from "../services/heartbeat.ts";
import { createFailoverAdmissionService } from "../services/admission.js";
import { runningProcesses } from "../adapters/index.ts";
import type { Db } from "../services/database.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("admission-gated native dispatch surface", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-admission-native-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    // Let background adapter completions drain, then terminate leftovers so
    // cleanup cannot deadlock against them.
    await cancelLeftoverRuns();
    await waitForRunsIdle(5_000);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(companyDispatchEpochs);
    await db.delete(companyFailoverPolicies);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issues);
      await db.delete(agentRuntimeState);
      await db.delete(agentTaskSessions);
      await db.delete(agentConfigRevisions);
      await db.delete(agentApiKeys);
      await db.delete(agentMemberships);
      await db.delete(agentWakeupRequests);
      await db.delete(heartbeatRuns);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw new Error(`agent cleanup retained foreign keys: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(companies);
  });

  async function cancelLeftoverRuns() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const active = await db
        .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]));
      if (active.length === 0) return;
      const now = new Date();
      await db.update(heartbeatRuns).set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
        errorCode: "test_cleanup",
        processPid: null,
        processGroupId: null,
      }).where(inArray(heartbeatRuns.id, active.map((run) => run.id)));
      const wakeupIds = active
        .map((run) => run.wakeupRequestId)
        .filter((value): value is string => typeof value === "string");
      if (wakeupIds.length > 0) {
        await db.update(agentWakeupRequests).set({
          status: "cancelled",
          finishedAt: now,
        }).where(inArray(agentWakeupRequests.id, wakeupIds));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function waitForRunsIdle(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

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

  async function seedQueuedRun(input?: { admitted?: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
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
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      claimedAt: null,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
      responsibleUserId: "responsible-user",
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Standby gated work",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    if (input?.admitted) {
      const admission = createFailoverAdmissionService(db);
      await admission.tryAdmitStandby(companyId, "instance-standby", "unavailable");
    }
    return { companyId, agentId, runId, issueId };
  }

  function heartbeatWithGate(
    gate: ((input: { companyId: string }) => Promise<boolean>) | undefined,
    consulted?: string[],
  ) {
    return heartbeatService(db, {
      dispatchGate: gate
        ? async (input) => {
            const allowed = await gate(input);
            if (consulted) consulted.push(input.companyId);
            return allowed;
          }
        : undefined,
      runtimeEnv: { PAPERCLIP_TELEMETRY_DISABLED: "1" },
    });
  }

  it("a non-admitted standby dispatches nothing for an ungated company", async () => {
    const admission = createFailoverAdmissionService(db);
    const seed = await seedQueuedRun();
    const heartbeat = heartbeatWithGate(async ({ companyId }) => admission.isDispatchAllowed(companyId, "instance-standby"));

    await heartbeat.startNextQueuedRunForAgent(seed.agentId);
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)).then((rows) => rows[0]!);
    expect(run.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("consults the admission gate with the candidate company before claiming", async () => {
    const admission = createFailoverAdmissionService(db);
    const seed = await seedQueuedRun();
    const consulted: string[] = [];
    const heartbeat = heartbeatWithGate(async ({ companyId }) => {
      consulted.push(companyId);
      return false;
    });

    await heartbeat.startNextQueuedRunForAgent(seed.agentId);
    expect(consulted).toEqual([seed.companyId]);
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)).then((rows) => rows[0]!);
    expect(run.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("a primary construction without a gate is never gated", async () => {
    const admission = createFailoverAdmissionService(db);
    const seed = await seedQueuedRun();
    void admission;
    const consulted: string[] = [];
    const heartbeat = heartbeatWithGate(undefined, consulted);
    await heartbeat.startNextQueuedRunForAgent(seed.agentId);
    expect(consulted).toEqual([]);
  });
});
