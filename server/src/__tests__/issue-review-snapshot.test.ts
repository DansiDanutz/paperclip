import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { issues } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import {
  advanceIssueReviewSnapshotAfterCheckout,
  assertIssueReviewSnapshotCurrent,
  captureIssueReviewSnapshot,
} from "../services/issue-review-snapshot.js";

describe("locked execution review snapshot", () => {
  it.each(Object.keys(getTableColumns(issues)))("binds persisted field %s", (field) => {
    const snapshot = captureIssueReviewSnapshot({});
    expect(() => assertIssueReviewSnapshotCurrent(snapshot, { [field]: "changed" }))
      .toThrowError(HttpError);
  });

  it("does not bind hydrated labels or other non-persisted projections", () => {
    const snapshot = captureIssueReviewSnapshot({ id: "issue", labels: ["old"] } as Partial<typeof issues.$inferSelect>);
    expect(() => assertIssueReviewSnapshotCurrent(snapshot, { id: "issue", labels: ["new"] } as Partial<typeof issues.$inferSelect>))
      .not.toThrow();
  });

  it("compares JSON structurally without discarding unknown keys or array ordering", () => {
    const executionPolicy = { stages: ["first", "second"], additionalAuthority: { a: 1, b: 2 } };
    const snapshot = captureIssueReviewSnapshot({ executionPolicy });
    expect(() => assertIssueReviewSnapshotCurrent(snapshot, {
      executionPolicy: { additionalAuthority: { b: 2, a: 1 }, stages: ["first", "second"] },
    })).not.toThrow();
    expect(() => assertIssueReviewSnapshotCurrent(snapshot, {
      executionPolicy: { ...executionPolicy, additionalAuthority: { a: 1, b: 3 } },
    })).toThrowError(HttpError);
    expect(() => assertIssueReviewSnapshotCurrent(snapshot, {
      executionPolicy: { ...executionPolicy, stages: ["second", "first"] },
    })).toThrowError(HttpError);
  });

  it("keeps the captured snapshot independent of later in-memory mutation", () => {
    const issue = { executionState: { round: { id: "original" } } };
    const snapshot = captureIssueReviewSnapshot(issue);
    issue.executionState.round.id = "replacement";
    expect(() => assertIssueReviewSnapshotCurrent(snapshot, issue)).toThrowError(HttpError);
  });

  it("preserves dates, null, zero, false and absent nested JSON keys distinctly", () => {
    const snapshot = captureIssueReviewSnapshot({ updatedAt: new Date(1000), executionState: { zero: 0, enabled: false, empty: null } });
    expect(() => assertIssueReviewSnapshotCurrent(snapshot, {
      updatedAt: new Date(1000), executionState: { enabled: false, empty: null, zero: 0 },
    })).not.toThrow();
    expect(() => assertIssueReviewSnapshotCurrent(snapshot, {
      updatedAt: new Date(1000), executionState: { zero: 0, enabled: false },
    })).toThrowError(HttpError);
  });

  it("returns only a fixed conflict code, never the changed review or task contents", () => {
    const snapshot = captureIssueReviewSnapshot({ description: "PRIVATE_OLD_SENTINEL" });
    try {
      assertIssueReviewSnapshotCurrent(snapshot, { description: "PRIVATE_NEW_SENTINEL" });
      throw new Error("Expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 409, details: { code: "execution_review_snapshot_changed" } });
      expect(JSON.stringify(error)).not.toContain("SENTINEL");
      expect(String(error)).not.toContain("SENTINEL");
    }
  });
});

describe("narrow native lifecycle snapshot advancement", () => {
  const original = {
    id: "issue", status: "in_progress", assigneeAgentId: "worker", assigneeUserId: null,
    checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
    updatedAt: new Date(1000), executionPolicy: { stages: ["review"] }, executionState: null,
  };
  const adopted = {
    ...original, checkoutRunId: "actor-run", executionRunId: "actor-run",
    executionLockedAt: new Date(2000), updatedAt: new Date(2000),
  };
  const preparation = {
    actorAgentId: "worker", actorRunId: "actor-run",
    ownership: {
      id: "issue", status: "in_progress", assigneeAgentId: "worker",
      checkoutRunId: "actor-run", executionRunId: "actor-run",
    },
  };

  it.each([null, "terminal-run"])("accepts native unowned/terminal adoption from %s", (oldRun) => {
    const before = { ...original, checkoutRunId: oldRun, executionRunId: oldRun };
    const advanced = advanceIssueReviewSnapshotAfterCheckout(captureIssueReviewSnapshot(before), adopted, preparation);
    expect(() => assertIssueReviewSnapshotCurrent(advanced, adopted)).not.toThrow();
    expect(() => assertIssueReviewSnapshotCurrent(advanced, { ...adopted, executionRunId: "new-run" })).toThrowError(HttpError);
  });

  it.each([
    { assigneeAgentId: "foreign" }, { executionPolicy: { stages: ["replacement"] } },
    { executionState: { status: "approved" } }, { title: "changed task" },
    { checkoutRunId: "foreign-run" }, { executionRunId: "foreign-run" },
    { executionAgentNameKey: "foreign-name" }, { executionLockedAt: null },
    { updatedAt: new Date(NaN) },
  ])("rejects unrelated mutation during checkout preparation %#", (change) => {
    expect(() => advanceIssueReviewSnapshotAfterCheckout(
      captureIssueReviewSnapshot(original), { ...adopted, ...change }, preparation,
    )).toThrowError(HttpError);
  });

  it.each([
    { actorAgentId: "other" }, { actorRunId: "" },
    { ownership: { ...preparation.ownership, id: "other" } },
    { ownership: { ...preparation.ownership, status: "done" } },
    { ownership: { ...preparation.ownership, assigneeAgentId: "other" } },
    { ownership: { ...preparation.ownership, executionRunId: "other-run" } },
  ])("rejects an invalid native ownership postcondition %#", (change) => {
    expect(() => advanceIssueReviewSnapshotAfterCheckout(
      captureIssueReviewSnapshot(original), adopted, { ...preparation, ...change },
    )).toThrowError(HttpError);
  });

  it("preserves full-row comparison when checkout ownership did not change", () => {
    expect(() => advanceIssueReviewSnapshotAfterCheckout(
      captureIssueReviewSnapshot(adopted),
      { ...adopted, title: "changed task" },
      preparation,
    )).toThrowError(HttpError);
    expect(() => advanceIssueReviewSnapshotAfterCheckout(
      captureIssueReviewSnapshot(adopted), adopted, preparation,
    )).not.toThrow();
  });
});
