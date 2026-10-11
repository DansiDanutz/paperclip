import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listEscalationsForIssue, saveEscalation, withRecordLock, type EscalationRecord } from "../src/state.js";

describe("escalation record lock", () => {
  it("does not overlap mutations of the same escalation", async () => {
    let current = 0;
    let max = 0;
    await Promise.all([1, 2, 3, 4].map(() => withRecordLock("esc-lock", async () => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 15));
      current -= 1;
    })));
    expect(max).toBe(1);
  });

  it("lists both escalations when two saves share an issue", async () => {
    const store = new Map<string, unknown>();
    const keyOf = (input: { scopeKind: string; scopeId?: string; stateKey: string }) =>
      `${input.scopeKind}:${input.scopeId ?? ""}:${input.stateKey}`;
    const ctx = {
      state: {
        async get(input: { scopeKind: string; scopeId?: string; stateKey: string }) {
          await Promise.resolve();
          return store.has(keyOf(input)) ? store.get(keyOf(input)) : null;
        },
        async set(input: { scopeKind: string; scopeId?: string; stateKey: string }, value: unknown) {
          await Promise.resolve();
          store.set(keyOf(input), value);
        },
      },
    } as PluginContext;
    const record = (id: string): EscalationRecord => ({
      id,
      companyId: "co",
      issueId: "issue-1",
      failedRunId: `run-${id}`,
      failedAgentId: "agent",
      failedAdapterType: "claude_local",
      error: null,
      errorCode: null,
      stdoutExcerpt: null,
      stderrExcerpt: null,
      repoUrl: null,
      repoRef: null,
      branchName: null,
      cwd: null,
      baselinePorcelain: null,
      candidates: [],
      proposals: [],
      judge: null,
      status: "fanning_out",
      slack: null,
      decision: null,
      failureNote: null,
      version: 1,
      delivery: null,
      proposalDeadlineAt: null,
      createdAt: "2026-10-09T00:00:00.000Z",
      updatedAt: "2026-10-09T00:00:00.000Z",
    });
    await Promise.all([saveEscalation(ctx, record("esc-a")), saveEscalation(ctx, record("esc-b"))]);
    const listed = await listEscalationsForIssue(ctx, "co", "issue-1");
    expect(listed.map((entry) => entry.id).sort()).toEqual(["esc-a", "esc-b"]);
  });
});