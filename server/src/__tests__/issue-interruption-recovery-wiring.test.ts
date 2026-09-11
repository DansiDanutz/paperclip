import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueInterruptions,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_input?: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Recovered stranded heartbeat work.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

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

import { heartbeatService, resolveHeartbeatSchedulingSuppression } from "../services/heartbeat.ts";
import { createIssueInterruptionService } from "../services/issue-interruption.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("pending issue interruption reconciliation wiring", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-interruption-wiring-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    // Force-cancel leftover active runs, then let background completions drain
    // so cleanup cannot deadlock against them.
    await cancelLeftoverRuns();
    await waitForRunsToSettle(5_000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(issueRecoveryActions);
      await db.delete(issueComments);
      await db.delete(issueInterruptions);
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      try {
        await db.delete(agentWakeupRequests);
        break;
      } catch {
        if (attempt === 4) throw new Error("wakeup cleanup retained heartbeat runs");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issues);
      await db.delete(agentRuntimeState);
      await db.delete(agentWakeupRequests);
      await db.delete(heartbeatRuns);
      try {
        await db.delete(agents);
        break;
      } catch {
        if (attempt === 4) throw new Error("agent cleanup retained foreign keys");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await waitForRunsToSettle(2_000);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function waitForRunsToSettle(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

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
        error: "Cancelled by issue-interruption test cleanup",
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
          error: "Cancelled by issue-interruption test cleanup",
        }).where(inArray(agentWakeupRequests.id, wakeupIds));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function seedCommittedInterruption(input?: { agentStatus?: "idle" | "paused" }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const operationId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
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
      status: input?.agentStatus ?? "idle",
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
      status: "claimed",
      runId,
      claimedAt: now,
    });
    // The composite transaction committed: run cancelled, receipt pending.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      wakeupRequestId,
      contextSnapshot: { issueId },
      responsibleUserId: "responsible-user",
      finishedAt: now,
      errorCode: "operator_interrupted",
      error: "Interrupted by board comment",
      startedAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Committed interruption awaiting continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issueInterruptions).values({
      id: operationId,
      companyId,
      issueId,
      cancelledRunId: runId,
      kind: "board_interrupt",
      state: "pending",
    });
    return { companyId, agentId, runId, issueId, operationId };
  }

  it("startup-style reconciliation completes a receipt a crash left pending", async () => {
    const heartbeat = heartbeatService(db);
    const interruptions = createIssueInterruptionService(db, { heartbeat });
    const seed = await seedCommittedInterruption();

    const result = await interruptions.reconcilePendingInterruptions();
    expect(result.suppressed).toBe(false);
    expect(result.completed).toBe(1);
    expect(result.continuationsQueued).toBe(1);

    const receipt = await db.select().from(issueInterruptions).where(eq(issueInterruptions.id, seed.operationId));
    expect(receipt[0]).toMatchObject({ state: "completed", outcome: "continuation_queued" });
    const replacement = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, seed.runId));
    expect(replacement).toHaveLength(1);
    // A second startup pass changes nothing.
    const repeat = await interruptions.reconcilePendingInterruptions();
    expect(repeat.completed).toBe(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, seed.runId)))
      .toHaveLength(1);
  });

  it("keeps pending evidence inspectable while heartbeat scheduling is suppressed", async () => {
    expect(resolveHeartbeatSchedulingSuppression({ PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1" }))
      .toEqual({ suppressed: true, reason: "database_restore_in_progress" });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1" },
    });
    const interruptions = createIssueInterruptionService(db, { heartbeat });
    const seed = await seedCommittedInterruption();

    const result = await interruptions.reconcilePendingInterruptions();
    expect(result.suppressed).toBe(true);
    expect(result.completed).toBe(0);

    const receipt = await db.select().from(issueInterruptions).where(eq(issueInterruptions.id, seed.operationId));
    expect(receipt[0]).toMatchObject({ state: "pending", outcome: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, seed.runId)))
      .toHaveLength(0);
  });

  it("completes pending receipts from multiple companies without cross-company interference", async () => {
    const heartbeat = heartbeatService(db);
    const interruptions = createIssueInterruptionService(db, { heartbeat });
    const first = await seedCommittedInterruption();
    const second = await seedCommittedInterruption();

    const result = await interruptions.reconcilePendingInterruptions();
    expect(result.completed).toBe(2);
    expect(result.continuationsQueued).toBe(2);

    for (const seed of [first, second]) {
      const receipt = await db.select().from(issueInterruptions).where(eq(issueInterruptions.id, seed.operationId));
      expect(receipt[0]).toMatchObject({ state: "completed", outcome: "continuation_queued" });
      expect(receipt[0].companyId).toBe(seed.companyId);
      const replacements = await db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, seed.companyId));
      expect(replacements.some((run) => run.retryOfRunId === seed.runId)).toBe(true);
    }
  });
});
