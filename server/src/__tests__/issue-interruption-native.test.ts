import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueInterruptions,
  issueWorkProducts,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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

import express from "express";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { runningProcesses } from "../adapters/index.ts";
import type { Db } from "../services/database.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("native coordinated issue interruption routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ReturnType<typeof spawn>>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-interruption-native-");
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
    for (const child of childProcesses) child.kill("SIGKILL");
    childProcesses.clear();
    // Force-cancel leftover active runs, then let background completions drain
    // so cleanup cannot deadlock against them.
    await cancelLeftoverRuns();
    await waitForRunsToSettle(5_000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(issueInterruptions);
      await db.delete(heartbeatRunEvents);
      await db.delete(issueComments);
      await db.delete(issueWorkProducts);
      await db.delete(documentAnnotationComments);
      await db.delete(documentAnnotationAnchorSnapshots);
      await db.delete(documentAnnotationThreads);
      await db.delete(documentRevisions);
      await db.delete(documents);
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
        await db.delete(companyMemberships);
        await db.delete(agents);
        break;
      } catch {
        if (attempt === 4) throw new Error("agent cleanup retained foreign keys");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await waitForRunsToSettle(2_000);
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companies);
  });

  afterAll(async () => {
    for (const child of childProcesses) child.kill("SIGKILL");
    childProcesses.clear();
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

  async function seedInterruptibleRun(input?: {
    agentStatus?: "idle" | "paused";
    runStatus?: "running" | "scheduled_retry";
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
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    const userId = `board-user-${randomUUID()}`;
    const { companyMemberships, principalPermissionGrants } = await import("@paperclipai/db");
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: now,
    });
    const { ensureHumanRoleDefaultGrants } = await import("../services/principal-access-compatibility.js");
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
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
      responsibleUserId: "responsible-user",
      scheduledRetryReason: input?.runStatus === "scheduled_retry" ? "codex_transient" : null,
      startedAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Original interruptible title",
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

    const actor = {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
    return { companyId, agentId, runId, wakeupRequestId, issueId, issuePrefix, app };
  }

  async function commentCount(issueId: string) {
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    return rows;
  }

  async function receiptsFor(companyId: string) {
    return db.select().from(issueInterruptions).where(eq(issueInterruptions.companyId, companyId));
  }

  it("persists the requested edit and exactly one comment for a sole-run board interruption", async () => {
    const seed = await seedInterruptibleRun();
    const res = await request(seed.app)
      .patch(`/api/issues/${seed.issueId}`)
      .send({ title: "Retitled by the operator", interrupt: true, comment: "Stop and take new direction" })
      .expect(200);
    expect(res.body).toMatchObject({ title: "Retitled by the operator" });

    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    expect(issue.title).toBe("Retitled by the operator");
    const comments = await commentCount(seed.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("Stop and take new direction");

    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)).then((rows) => rows[0]!);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "operator_interrupted" });

    const replacements = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, seed.runId));
    // The replacement exists durably; the post-commit dispatch may already have
    // started or finished it, so only its existence is asserted here.
    expect(replacements).toHaveLength(1);

    const receipts = await receiptsFor(seed.companyId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      state: "completed",
      outcome: "continuation_queued",
      cancelledRunId: seed.runId,
      continuationRunId: replacements[0].id,
      kind: "board_interrupt",
    });
  }, 30_000);

  it("supersedes a sole scheduled retry with the requested comment", async () => {
    const seed = await seedInterruptibleRun({ runStatus: "scheduled_retry" });
    await request(seed.app)
      .patch(`/api/issues/${seed.issueId}`)
      .send({ comment: "Please restart with the updated guidance" })
      .expect(200);

    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)).then((rows) => rows[0]!);
    expect(run).toMatchObject({ status: "cancelled" });

    // The issue passes through todo on resume; the completed continuation may
    // already have dispatched and moved it back to in_progress by now.
    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    expect(["todo", "in_progress"]).toContain(issue.status);
    const comments = await commentCount(seed.issueId);
    expect(comments).toHaveLength(1);

    const receipts = await receiptsFor(seed.companyId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      state: "completed",
      kind: "scheduled_retry_supersession",
      cancelledRunId: seed.runId,
    });
    expect(receipts[0].outcome).toMatch(/continuation_queued|no_continuation_needed/);
  }, 30_000);

  it("does not silently supersede a scheduled retry that already started running", async () => {
    const seed = await seedInterruptibleRun({ runStatus: "running" });
    await db.update(heartbeatRuns).set({ scheduledRetryReason: "codex_transient" })
      .where(eq(heartbeatRuns.id, seed.runId));

    await request(seed.app)
      .patch(`/api/issues/${seed.issueId}`)
      .send({ comment: "Please restart with the updated guidance" })
      .expect(409);

    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)).then((rows) => rows[0]!);
    expect(run).toMatchObject({ status: "running" });
    const comments = await commentCount(seed.issueId);
    expect(comments).toHaveLength(0);
    expect(await receiptsFor(seed.companyId)).toHaveLength(0);
  }, 30_000);

  it("rejects a losing concurrent interruption without cancelling, commenting or receipting twice", async () => {
    const seed = await seedInterruptibleRun();
    const [first, second] = await Promise.all([
      request(seed.app)
        .patch(`/api/issues/${seed.issueId}`)
        .send({ title: "First operator title", interrupt: true, comment: "First operator comment" }),
      request(seed.app)
        .patch(`/api/issues/${seed.issueId}`)
        .send({ title: "Second operator title", interrupt: true, comment: "Second operator comment" }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Exactly one request won: one comment, one receipt, one replacement, one title.
    const comments = await commentCount(seed.issueId);
    expect(comments).toHaveLength(1);
    const winnerTitle = first.status === 200 ? "First operator title" : "Second operator title";
    const winnerComment = first.status === 200 ? "First operator comment" : "Second operator comment";
    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    expect(issue.title).toBe(winnerTitle);
    expect(comments[0].body).toBe(winnerComment);

    const replacements = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, seed.runId));
    expect(replacements).toHaveLength(1);
    const receipts = await receiptsFor(seed.companyId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ state: "completed", outcome: "continuation_queued" });
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)).then((rows) => rows[0]!);
    expect(run).toMatchObject({ status: "cancelled" });
  }, 30_000);

  it("reports a failed physical stop without committing cancellation, edit or comment", async () => {
    const seed = await seedInterruptibleRun();
    await db.update(heartbeatRuns).set({ processPid: 999_999_999 }).where(eq(heartbeatRuns.id, seed.runId));
    mockTerminateLocalService.mockImplementation(async () => {
      throw new Error("simulated bounded stop failure");
    });

    await request(seed.app)
      .patch(`/api/issues/${seed.issueId}`)
      .send({ title: "Must not persist", interrupt: true, comment: "Must not persist" })
      .expect(500);

    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)).then((rows) => rows[0]!);
    expect(run).toMatchObject({ status: "running" });
    const issue = await db.select().from(issues).where(eq(issues.id, seed.issueId)).then((rows) => rows[0]!);
    expect(issue.title).toBe("Original interruptible title");
    expect(await commentCount(seed.issueId)).toHaveLength(0);
    expect(await receiptsFor(seed.companyId)).toHaveLength(0);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seed.runId));
    expect(events).toHaveLength(0);
  }, 30_000);

  it("stops only the owned synthetic process and still persists the composite write", async () => {
    // Spawn the child detached so it leads its own process group, matching how
    // real run processes are grouped and terminated.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    childProcesses.add(child);
    const seed = await seedInterruptibleRun();
    await db.update(heartbeatRuns).set({ processPid: child.pid ?? null, processGroupId: child.pid ?? null })
      .where(eq(heartbeatRuns.id, seed.runId));
    expect(child.pid).toBeTypeOf("number");

    await request(seed.app)
      .patch(`/api/issues/${seed.issueId}`)
      .send({ title: "Interrupted with a live process", interrupt: true, comment: "Owned process stopped" })
      .expect(200);

    const exited = await waitForPidExit(child.pid!);
    expect(exited).toBe(true);
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)).then((rows) => rows[0]!);
    expect(run).toMatchObject({ status: "cancelled" });
    expect(await commentCount(seed.issueId)).toHaveLength(1);
    expect(await receiptsFor(seed.companyId)).toHaveLength(1);
  }, 30_000);

  async function waitForPidExit(pid: number, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }
});
