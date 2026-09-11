import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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
  issueRecoveryActions,
  issues,
  issueInterruptions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockTerminateLocalService = vi.hoisted(() => vi.fn());
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

vi.mock("../services/local-service-supervisor.js", async () => {
  const actual = await vi.importActual<typeof import("../services/local-service-supervisor.js")>(
    "../services/local-service-supervisor.js",
  );
  mockTerminateLocalService.mockImplementation(actual.terminateLocalService);
  return {
    ...actual,
    terminateLocalService: mockTerminateLocalService,
  };
});

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

import { heartbeatService } from "../services/heartbeat.ts";
import { createIssueInterruptionService } from "../services/issue-interruption.js";
import { HttpError } from "../errors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;
type Interruptions = ReturnType<typeof createIssueInterruptionService>;

describeEmbeddedPostgres("coordinated issue interruption receipts", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: Heartbeat;
  let interruptions!: Interruptions;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-interruption-");
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
    mockTerminateLocalService.mockImplementation(
      (await vi.importActual<typeof import("../services/local-service-supervisor.js")>(
        "../services/local-service-supervisor.js",
      )).terminateLocalService,
    );
    runningProcesses.clear();
    // Force-cancel leftover active runs (seeded running rows have no real
    // process and would never settle on their own), then let any background
    // adapter completions drain so cleanup cannot deadlock against them.
    await cancelLeftoverRuns();
    await waitForRunsToSettle(5_000);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issueInterruptions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
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

  async function seedRunningIssueRun(input?: {
    agentStatus?: "idle" | "paused";
    runStatus?: "running" | "scheduled_retry" | "succeeded" | "cancelled";
    withResponsibleUser?: boolean;
    companyDefaultResponsibleUser?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      ...(input?.companyDefaultResponsibleUser === false ? {} : { defaultResponsibleUserId: "responsible-user" }),
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
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: { issueId },
      responsibleUserId: input?.withResponsibleUser === false ? null : "responsible-user",
      startedAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Interrupted issue needs coordinated continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      responsibleUserId: input?.withResponsibleUser === false ? null : "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  function buildService() {
    heartbeat = heartbeatService(db);
    interruptions = createIssueInterruptionService(db, { heartbeat });
    return { heartbeat, interruptions };
  }

  const boardInterruptOptions = {
    errorCode: "operator_interrupted",
    resultJson: { operatorInterrupted: true },
    eventMessage: "run interrupted by board comment",
    eventPayload: { source: "issue_comment_interrupt" },
  };

  async function commitCompositeCancellation(input: {
    interruptions: Interruptions;
    heartbeat: Heartbeat;
    issueId: string;
    runId: string;
    kind: "board_interrupt" | "scheduled_retry_supersession";
  }) {
    const issue = await db.select().from(issues).where(eq(issues.id, input.issueId)).then((rows) => rows[0]!);
    const run = await input.heartbeat.getRun(input.runId);
    if (!run) throw new Error("prepared run missing");
    return db.transaction(async (tx) =>
      input.interruptions.cancelRunForCompositeIssueUpdate(tx, {
        issue,
        run,
        kind: input.kind,
        reason: "Interrupted by board comment",
        options: boardInterruptOptions,
      }),
    );
  }

  it("conditionally terminalizes only the exact observed run status inside the caller transaction", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun();
    const result = await commitCompositeCancellation({
      interruptions: svc, heartbeat: hb, issueId: seed.issueId, runId: seed.runId, kind: "board_interrupt",
    });
    expect(result).toMatchObject({ cancelledRunId: seed.runId, childOutcomeWon: false });
    const run = await hb.getRun(seed.runId);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "operator_interrupted" });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seed.runId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "lifecycle", message: "run interrupted by board comment" });
    const wakeup = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seed.wakeupRequestId));
    expect(wakeup[0]).toMatchObject({ status: "cancelled" });
    // The release/promotion has NOT run yet: the issue still names the cancelled run.
    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    expect(issue.executionRunId).toBe(seed.runId);
  });

  it("preserves a child outcome that already won instead of overwriting it", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun({ runStatus: "succeeded" });
    const result = await commitCompositeCancellation({
      interruptions: svc, heartbeat: hb, issueId: seed.issueId, runId: seed.runId, kind: "board_interrupt",
    });
    expect(result).toMatchObject({ cancelledRunId: null, childOutcomeWon: true });
    const run = await hb.getRun(seed.runId);
    expect(run).toMatchObject({ status: "succeeded" });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seed.runId));
    expect(events).toHaveLength(0);
  });

  it("rejects revalidation when the run moved to another still-live status before the CAS", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    // A scheduled retry promoted scheduled_retry -> queued between observation
    // and transaction: still cancellable, but no longer in the observed state.
    const seedRetry = await seedRunningIssueRun({ runStatus: "scheduled_retry" });
    const issueRetry = await db.select().from(issues).where(eq(issues.id, seedRetry.issueId)).then((rows) => rows[0]!);
    const observedRetry = await hb.getRun(seedRetry.runId);
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, seedRetry.runId));
    await expect(db.transaction(async (tx) =>
      svc.cancelRunForCompositeIssueUpdate(tx, {
        issue: issueRetry, run: observedRetry!, kind: "scheduled_retry_supersession",
        reason: "Cancelled by control plane", options: {},
      }),
    )).rejects.toBeInstanceOf(HttpError);
    // Same conflation guard for a board interrupt whose run left `running`.
    const seedRun = await seedRunningIssueRun({ runStatus: "running" });
    const issueRun = await db.select().from(issues).where(eq(issues.id, seedRun.issueId)).then((rows) => rows[0]!);
    const observedRun = await hb.getRun(seedRun.runId);
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, seedRun.runId));
    await expect(db.transaction(async (tx) =>
      svc.cancelRunForCompositeIssueUpdate(tx, {
        issue: issueRun, run: observedRun!, kind: "board_interrupt",
        reason: "Interrupted by board comment", options: boardInterruptOptions,
      }),
    )).rejects.toBeInstanceOf(HttpError);
    // Nothing was cancelled, no receipts exist, and both runs are still live.
    for (const seed of [seedRetry, seedRun]) {
      const run = await hb.getRun(seed.runId);
      expect(["queued", "running"]).toContain(run!.status);
    }
    expect(await db.select().from(issueInterruptions)).toHaveLength(0);
  });

  it("rejects a prepared run that the locked issue no longer names", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId: seed.companyId,
      agentId: seed.agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { issueId: seed.issueId },
      updatedAt: new Date(),
    });
    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    const foreignRun = await hb.getRun(otherRunId);
    await expect(db.transaction(async (tx) =>
      svc.cancelRunForCompositeIssueUpdate(tx, {
        issue, run: foreignRun!, kind: "board_interrupt",
        reason: "Interrupted by board comment", options: boardInterruptOptions,
      }),
    )).rejects.toBeInstanceOf(HttpError);
    const untouched = await hb.getRun(otherRunId);
    expect(untouched).toMatchObject({ status: "running" });
  });

  it("rejects a cross-company prepared run", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seedA = await seedRunningIssueRun();
    const seedB = await seedRunningIssueRun();
    const issueB = await db.select().from(issues).where(eq(issues.id, seedB.issueId)).then((rows) => rows[0]!);
    const runA = await hb.getRun(seedA.runId);
    await expect(db.transaction(async (tx) =>
      svc.cancelRunForCompositeIssueUpdate(tx, {
        issue: issueB, run: runA!, kind: "board_interrupt",
        reason: "Interrupted by board comment", options: boardInterruptOptions,
      }),
    )).rejects.toBeInstanceOf(HttpError);
  });

  it("refuses to supersede a scheduled retry that already started running", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun({ runStatus: "running" });
    await db.update(heartbeatRuns).set({ scheduledRetryReason: "codex_transient" }).where(eq(heartbeatRuns.id, seed.runId));
    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    const run = await hb.getRun(seed.runId);
    await expect(db.transaction(async (tx) =>
      svc.cancelRunForCompositeIssueUpdate(tx, {
        issue, run: run!, kind: "scheduled_retry_supersession",
        reason: "Cancelled by control plane", options: {},
      }),
    )).rejects.toBeInstanceOf(HttpError);
    const untouched = await hb.getRun(seed.runId);
    expect(untouched).toMatchObject({ status: "running" });
  });

  it("rolls the whole composite back when a later persistence boundary fails", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun();
    // Pre-seed the receipt tuple so the receipt insert fails after the run CAS.
    await db.insert(issueInterruptions).values({
      id: randomUUID(),
      companyId: seed.companyId,
      issueId: seed.issueId,
      cancelledRunId: seed.runId,
      kind: "board_interrupt",
      state: "completed",
      outcome: "no_continuation_needed",
    });
    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    const run = await hb.getRun(seed.runId);
    await expect(db.transaction(async (tx) => {
      await svc.cancelRunForCompositeIssueUpdate(tx, {
        issue, run: run!, kind: "board_interrupt",
        reason: "Interrupted by board comment", options: boardInterruptOptions,
      });
      await svc.insertPendingInterruptionReceipt(tx, {
        operationId: randomUUID(), companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    })).rejects.toBeInstanceOf(HttpError);
    const reverted = await hb.getRun(seed.runId);
    expect(reverted).toMatchObject({ status: "running" });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seed.runId));
    expect(events).toHaveLength(0);
    const receipts = await db.select().from(issueInterruptions).where(and(
      eq(issueInterruptions.companyId, seed.companyId),
      eq(issueInterruptions.cancelledRunId, seed.runId),
    ));
    expect(receipts).toHaveLength(1);
  });

  it("enforces one receipt per complete company/issue/run tuple", async () => {
    buildService();
    const seed = await seedRunningIssueRun({ runStatus: "cancelled" });
    const operationId = randomUUID();
    await db.transaction(async (tx) => {
      await interruptions.insertPendingInterruptionReceipt(tx, {
        operationId, companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    });
    await expect(db.transaction(async (tx) => {
      await interruptions.insertPendingInterruptionReceipt(tx, {
        operationId: randomUUID(), companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    })).rejects.toBeInstanceOf(HttpError);
    const receipts = await db.select().from(issueInterruptions).where(and(
      eq(issueInterruptions.companyId, seed.companyId),
      eq(issueInterruptions.issueId, seed.issueId),
    ));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].id).toBe(operationId);
  });

  it("completes a committed receipt by queueing the continuation and recording the selected run", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun({ runStatus: "cancelled" });
    const operationId = randomUUID();
    await db.transaction(async (tx) => {
      await svc.insertPendingInterruptionReceipt(tx, {
        operationId, companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    });
    const result = await svc.completePendingInterruptions({ operationId, reason: "test_commit" });
    expect(result).toMatchObject({ completed: 1, continuationsQueued: 1, skippedClaimedElsewhere: 0 });
    const receipt = await db.select().from(issueInterruptions).where(eq(issueInterruptions.id, operationId));
    expect(receipt[0]).toMatchObject({ state: "completed", outcome: "continuation_queued" });
    expect(receipt[0].continuationRunId).not.toBeNull();
    const continuations = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, seed.runId));
    expect(continuations).toHaveLength(1);
    expect(continuations[0].id).toBe(receipt[0].continuationRunId);
    // The post-commit dispatch may already have started the replacement; the
    // durable fact is that it was queued for the agent.
    expect(continuations[0].status).not.toBe("scheduled_retry");
    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    expect(issue.executionRunId).toBe(receipt[0].continuationRunId);
    await waitForRunsToSettle();
  });

  it("records a verified no-op when the issue no longer needs continuation", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun({ runStatus: "cancelled" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seed.issueId));
    const operationId = randomUUID();
    await db.transaction(async (tx) => {
      await svc.insertPendingInterruptionReceipt(tx, {
        operationId, companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    });
    const result = await svc.completePendingInterruptions({ operationId, reason: "test_noop" });
    expect(result).toMatchObject({ completed: 1, continuationsQueued: 0 });
    const receipt = await db.select().from(issueInterruptions).where(eq(issueInterruptions.id, operationId));
    expect(receipt[0]).toMatchObject({ state: "completed", outcome: "no_continuation_needed", continuationRunId: null });
    await waitForRunsToSettle();
  });

  it("prefers the existing deferred wake promotion over a fresh recovery run", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun({ runStatus: "cancelled" });
    const deferredWakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId: seed.companyId,
      agentId: seed.agentId,
      source: "on_demand",
      triggerDetail: "system",
      reason: "issue_execution_promoted",
      payload: { issueId: seed.issueId },
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    const operationId = randomUUID();
    await db.transaction(async (tx) => {
      await svc.insertPendingInterruptionReceipt(tx, {
        operationId, companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    });
    await svc.completePendingInterruptions({ operationId, reason: "test_deferred" });
    const receipt = await db.select().from(issueInterruptions).where(eq(issueInterruptions.id, operationId));
    expect(receipt[0]).toMatchObject({ state: "completed", outcome: "continuation_queued" });
    const promotedRuns = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, seed.companyId), eq(heartbeatRuns.wakeupRequestId, deferredWakeupId)));
    expect(promotedRuns).toHaveLength(1);
    expect(promotedRuns[0].id).toBe(receipt[0].continuationRunId);
    // The promoted wake drives real work; its status has moved on by the time
    // this read happens, so only the durable linkage is asserted.
    await waitForRunsToSettle();
  });

  it("leaves the receipt pending with no durable continuation when the continuation persistence crashes", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    // No responsible user anywhere: the recovery seeding cannot resolve one and throws.
    const seed = await seedRunningIssueRun({
      runStatus: "cancelled", withResponsibleUser: false, companyDefaultResponsibleUser: false,
    });
    const operationId = randomUUID();
    await db.transaction(async (tx) => {
      await svc.insertPendingInterruptionReceipt(tx, {
        operationId, companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    });
    await expect(svc.completePendingInterruptions({ operationId, reason: "test_crash" }))
      .rejects.toBeInstanceOf(HttpError);
    const receipt = await db.select().from(issueInterruptions).where(eq(issueInterruptions.id, operationId));
    expect(receipt[0]).toMatchObject({ state: "pending", outcome: null, continuationRunId: null });
    const continuations = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, seed.runId));
    expect(continuations).toHaveLength(0);
    // Once the durable input exists again, the same pending receipt completes exactly once.
    await db.update(companies).set({ defaultResponsibleUserId: "responsible-user" })
      .where(eq(companies.id, seed.companyId));
    const result = await svc.completePendingInterruptions({ operationId, reason: "test_crash_retry" });
    expect(result).toMatchObject({ completed: 1, continuationsQueued: 1 });
    await waitForRunsToSettle();
  });

  it("keeps a blocked escalation inspectable and pending until the durable effect exists, then completes", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun({ agentStatus: "paused", runStatus: "cancelled" });
    const operationId = randomUUID();
    await db.transaction(async (tx) => {
      await svc.insertPendingInterruptionReceipt(tx, {
        operationId, companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    });
    const result = await svc.completePendingInterruptions({ operationId, reason: "test_blocked" });
    expect(result.completed).toBe(1);
    const receipt = await db.select().from(issueInterruptions).where(eq(issueInterruptions.id, operationId));
    expect(receipt[0]).toMatchObject({ state: "completed", outcome: "no_continuation_needed" });
    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    expect(issue.status).toBe("blocked");
    const recoveryActions = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, seed.issueId));
    expect(recoveryActions.length).toBeGreaterThanOrEqual(1);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seed.issueId));
    expect(comments.length).toBe(1);
  });

  it("never duplicates the durable continuation across repeated and concurrent reconcilers", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun({ runStatus: "cancelled" });
    const operationId = randomUUID();
    await db.transaction(async (tx) => {
      await svc.insertPendingInterruptionReceipt(tx, {
        operationId, companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    });
    await svc.completePendingInterruptions({ operationId, reason: "test_first" });
    const repeat = await svc.completePendingInterruptions({ operationId, reason: "test_repeat" });
    expect(repeat.completed).toBe(0);

    // Fresh concurrent reconcilers over a second pending receipt.
    const seed2 = await seedRunningIssueRun({ runStatus: "cancelled" });
    const operationId2 = randomUUID();
    await db.transaction(async (tx) => {
      await svc.insertPendingInterruptionReceipt(tx, {
        operationId: operationId2, companyId: seed2.companyId, issueId: seed2.issueId,
        cancelledRunId: seed2.runId, kind: "board_interrupt",
      });
    });
    const racingReconciler = createIssueInterruptionService(db, { heartbeat: hb });
    const [first, second] = await Promise.all([
      svc.completePendingInterruptions({ operationId: operationId2, reason: "test_race_a" }),
      racingReconciler.completePendingInterruptions({ operationId: operationId2, reason: "test_race_b" }),
    ]);
    const totalQueued = first.continuationsQueued + second.continuationsQueued;
    const totalSkipped = first.skippedClaimedElsewhere + second.skippedClaimedElsewhere;
    expect(totalQueued).toBe(1);
    expect(totalSkipped).toBe(1);
    const continuations = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, seed2.runId));
    expect(continuations).toHaveLength(1);
    await waitForRunsToSettle();
  });

  it("completes a crashed composite through an independent fresh reconciler instance", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun({ runStatus: "cancelled" });
    const operationId = randomUUID();
    await db.transaction(async (tx) => {
      await svc.insertPendingInterruptionReceipt(tx, {
        operationId, companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    });
    // A restarted server constructs fresh service instances over the same database.
    const restartedHeartbeat = heartbeatService(db);
    const restarted = createIssueInterruptionService(db, { heartbeat: restartedHeartbeat });
    const result = await restarted.reconcilePendingInterruptions();
    expect(result.suppressed).toBe(false);
    expect(result.completed).toBe(1);
    expect(result.continuationsQueued).toBe(1);
    const receipt = await db.select().from(issueInterruptions).where(eq(issueInterruptions.id, operationId));
    expect(receipt[0]).toMatchObject({ state: "completed", outcome: "continuation_queued" });
    await waitForRunsToSettle();
  });

  it("removes a pending receipt with its parent issue and dispatches nothing", async () => {
    buildService();
    const seed = await seedRunningIssueRun({ runStatus: "cancelled" });
    await db.transaction(async (tx) => {
      await interruptions.insertPendingInterruptionReceipt(tx, {
        operationId: randomUUID(), companyId: seed.companyId, issueId: seed.issueId,
        cancelledRunId: seed.runId, kind: "board_interrupt",
      });
    });
    expect(await db.select().from(issueInterruptions).where(and(
      eq(issueInterruptions.companyId, seed.companyId),
    ))).toHaveLength(1);
    await db.delete(issues).where(eq(issues.id, seed.issueId));
    const receipts = await db.select().from(issueInterruptions).where(and(
      eq(issueInterruptions.companyId, seed.companyId),
      eq(issueInterruptions.issueId, seed.issueId),
    ));
    expect(receipts).toHaveLength(0);
    const result = await interruptions.reconcilePendingInterruptions();
    expect(result.completed).toBe(0);
  });

  it("rejects malformed receipt states that would confer completion authority", async () => {
    buildService();
    const seed = await seedRunningIssueRun({ runStatus: "cancelled" });
    await expect(db.insert(issueInterruptions).values({
      id: randomUUID(), companyId: seed.companyId, issueId: seed.issueId,
      cancelledRunId: seed.runId, kind: "adapter_metadata",
    })).rejects.toThrow();
    await expect(db.insert(issueInterruptions).values({
      id: randomUUID(), companyId: seed.companyId, issueId: seed.issueId,
      cancelledRunId: seed.runId, kind: "board_interrupt", state: "completed",
    })).rejects.toThrow();
    await expect(db.insert(issueInterruptions).values({
      id: randomUUID(), companyId: seed.companyId, issueId: seed.issueId,
      cancelledRunId: seed.runId, kind: "board_interrupt", state: "completed",
      outcome: "continuation_queued",
    })).rejects.toThrow();
    await expect(db.insert(issueInterruptions).values({
      id: randomUUID(), companyId: seed.companyId, issueId: seed.issueId,
      cancelledRunId: seed.runId, kind: "board_interrupt", state: "completed",
      outcome: "no_continuation_needed", continuationRunId: randomUUID(),
    })).rejects.toThrow();
  });

  it("keeps ordinary standalone cancellation free of receipts and records", async () => {
    const { heartbeat: hb } = buildService();
    const seed = await seedRunningIssueRun();
    const cancelled = await hb.cancelRun(seed.runId, "Interrupted by board comment", boardInterruptOptions);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    const receipts = await db.select().from(issueInterruptions);
    expect(receipts).toHaveLength(0);
    // Existing stand-down semantics are unchanged: release still promotes recovery.
    const continuations = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, seed.runId));
    expect(continuations.length).toBe(1);
    await waitForRunsToSettle();
  });

  it("reports a failed physical stop without persisting cancellation state", async () => {
    const { heartbeat: hb, interruptions: svc } = buildService();
    const seed = await seedRunningIssueRun({ runStatus: "running" });
    await db.update(heartbeatRuns).set({ processPid: 999_999_999 }).where(eq(heartbeatRuns.id, seed.runId));
    mockTerminateLocalService.mockImplementation(async () => {
      throw new Error("simulated bounded stop failure");
    });
    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    const run = await hb.getRun(seed.runId);
    await expect(db.transaction(async (tx) =>
      svc.cancelRunForCompositeIssueUpdate(tx, {
        issue, run: run!, kind: "board_interrupt",
        reason: "Interrupted by board comment", options: boardInterruptOptions,
      }),
    )).rejects.toThrow("simulated bounded stop failure");
    const reverted = await hb.getRun(seed.runId);
    expect(reverted).toMatchObject({ status: "running" });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seed.runId));
    expect(events).toHaveLength(0);
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

  async function waitForRunsToSettle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]));
      if (runs.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});
