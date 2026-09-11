import { isDeepStrictEqual } from "node:util";
import { getTableColumns } from "drizzle-orm";
import { issues } from "@paperclipai/db";
import { conflict } from "../errors.js";

type IssueRow = typeof issues.$inferSelect;
type ReviewSnapshot = Readonly<Record<keyof IssueRow, unknown>>;
const persistedFields = Object.keys(getTableColumns(issues)) as Array<keyof IssueRow>;

function snapshotConflict(): never {
  throw conflict("Issue changed while preparing the review transition; read it again before retrying", {
    code: "execution_review_snapshot_changed",
  });
}

function isTimestamp(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Bind a precomputed review transition to the complete persisted issue row.
 * Hydrated labels/read projections are excluded, but raw JSON metadata and
 * array order are retained. Do not normalize this through the policy parser.
 * A concurrent unrelated row edit conservatively requires a fresh request.
 */
export function captureIssueReviewSnapshot(issue: Partial<IssueRow>): ReviewSnapshot {
  return structuredClone(Object.fromEntries(
    persistedFields.map((field) => [field, issue[field] ?? null]),
  )) as ReviewSnapshot;
}

/** Caller must hold the native issue row lock until its mutation commits. */
export function assertIssueReviewSnapshotCurrent(
  expected: ReviewSnapshot,
  locked: Partial<IssueRow>,
): void {
  if (!isDeepStrictEqual(expected, captureIssueReviewSnapshot(locked))) {
    snapshotConflict();
  }
}

/** A successful native ownership check, never a caller-provided exemption. */
export type IssueCheckoutPreparation = {
  actorAgentId: string;
  actorRunId: string;
  ownership: Pick<IssueRow, "id" | "status" | "assigneeAgentId" | "checkoutRunId" | "executionRunId">;
};

/**
 * Advance only the native checkout repair's exact run postcondition. Policy,
 * state, owners, task content and monitor fields remain bound to the first read.
 * No arbitrary post-preparation refresh or replacement run is accepted.
 */
export function advanceIssueReviewSnapshotAfterCheckout(
  expected: ReviewSnapshot,
  current: Partial<IssueRow>,
  preparation: IssueCheckoutPreparation,
): ReviewSnapshot {
  const { ownership, actorAgentId, actorRunId } = preparation;
  if (
    !actorRunId || !actorAgentId
    || ownership.id !== expected.id
    || expected.status !== "in_progress" || ownership.status !== "in_progress"
    || expected.assigneeAgentId !== actorAgentId || ownership.assigneeAgentId !== actorAgentId
    || ownership.checkoutRunId !== actorRunId
    || (ownership.executionRunId !== actorRunId
      && ownership.executionRunId !== null
      && ownership.executionRunId !== expected.executionRunId)
  ) snapshotConflict();

  const pointersChanged = ownership.checkoutRunId !== expected.checkoutRunId
    || ownership.executionRunId !== expected.executionRunId;
  if (!pointersChanged) {
    assertIssueReviewSnapshotCurrent(expected, current);
    return expected;
  }
  // Adoption writes the actor run; terminal cleanup may instead leave the
  // already-owned checkout with no execution run. Neither can install a foreign run.
  if (ownership.executionRunId !== actorRunId && ownership.executionRunId !== null) snapshotConflict();
  if (!isTimestamp(current.updatedAt)) snapshotConflict();
  if (ownership.executionRunId === null) {
    if (current.executionLockedAt != null || current.executionAgentNameKey != null) snapshotConflict();
  } else if (
    !isTimestamp(current.executionLockedAt)
    || (current.executionAgentNameKey != null && current.executionAgentNameKey !== expected.executionAgentNameKey)
  ) snapshotConflict();

  const advanced = {
    ...expected,
    checkoutRunId: ownership.checkoutRunId,
    executionRunId: ownership.executionRunId,
    executionAgentNameKey: current.executionAgentNameKey ?? null,
    executionLockedAt: current.executionLockedAt ?? null,
    updatedAt: current.updatedAt,
  };
  assertIssueReviewSnapshotCurrent(advanced, current);
  return captureIssueReviewSnapshot(current);
}
