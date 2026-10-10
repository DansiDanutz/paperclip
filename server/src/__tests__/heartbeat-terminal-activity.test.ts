import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentRuntimeState, agentTaskSessions, agentWakeupRequests, agents, companies, companySkills, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { ERROR_ESCALATION_PROPOSAL_WAKE_REASON } from "../services/terminal-run-activity.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat activity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat terminal activity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-activity-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent(commandArgs: string[]) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Seme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Process",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: commandArgs,
        timeoutSec: 15,
      },
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function waitForActivity(companyId: string, action: string) {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
      const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      const terminal = runs.length > 0 && runs.every((run) =>
        run.status === "succeeded" || run.status === "failed" || run.status === "cancelled" || run.status === "timed_out",
      );
      const settled = events.some((event) => event.eventType === "lifecycle" && event.message?.startsWith("run "));
      if (terminal && settled && rows.some((row) => row.action === action)) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${action}`);
  }

  it("emits agent.run.failed with workspace fields for a failing process", async () => {
    const { companyId, agentId } = await insertAgent(["-e", "console.error('boom-from-fail'); process.exit(1)"]);
    await heartbeat.invoke(agentId, "on_demand", {
      paperclipWorkspace: {
        repoUrl: "https://github.com/DansiDanutz/paperclip",
        repoRef: "master",
        branchName: "master",
        cwd: "/tmp/not-used",
      },
    });
    const rows = await waitForActivity(companyId, "agent.run.failed");
    expect(rows.map((row) => row.action)).toEqual(["agent.run.failed"]);
    const details = rows[0]?.details as Record<string, unknown>;
    expect(details.adapterType).toBe("process");
    expect(details.escalationProposal).toBe(false);
    expect(details.error).toEqual(expect.stringContaining("Process exited"));
    expect(details.stderrExcerpt).toEqual(expect.stringContaining("boom-from-fail"));
    expect(details.repoUrl).toBe("https://github.com/DansiDanutz/paperclip");
    expect(details.branchName).toBe("master");
    expect(typeof details.cwd).toBe("string");
    expect(details.cwd).not.toBe("/tmp/not-used");
  });

  it("emits agent.run.finished for a successful process and nothing else", async () => {
    const { companyId, agentId } = await insertAgent(["-e", "console.log('ok-from-success'); process.exit(0)"]);
    await heartbeat.invoke(agentId, "on_demand", {});
    const rows = await waitForActivity(companyId, "agent.run.finished");
    expect(rows.map((row) => row.action)).toEqual(["agent.run.finished"]);
    const details = rows[0]?.details as Record<string, unknown>;
    expect(details.escalationProposal).toBe(false);
    expect(details.stdoutExcerpt).toEqual(expect.stringContaining("ok-from-success"));
  });

  it("marks a proposal wake on agent.run.failed without hiding the event", async () => {
    const { companyId, agentId } = await insertAgent(["-e", "console.error('proposal-boom'); process.exit(1)"]);
    await heartbeat.invoke(agentId, "on_demand", {
      wakeReason: ERROR_ESCALATION_PROPOSAL_WAKE_REASON,
      escalationPrompt: "proposal-only",
    });
    const rows = await waitForActivity(companyId, "agent.run.failed");
    expect(rows.map((row) => row.action)).toEqual(["agent.run.failed"]);
    const details = rows[0]?.details as Record<string, unknown>;
    expect(details.escalationProposal).toBe(true);
    expect(details.wakeReason).toBe(ERROR_ESCALATION_PROPOSAL_WAKE_REASON);
    expect(details.stderrExcerpt).toEqual(expect.stringContaining("proposal-boom"));
  });
});
