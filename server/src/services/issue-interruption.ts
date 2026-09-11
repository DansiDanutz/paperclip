import { and, asc, eq } from "drizzle-orm";
import {
  heartbeatRuns,
  issueInterruptions,
  issues,
  type Db,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { heartbeatService } from "./heartbeat.js";

type IssueRow = typeof issues.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type Executor = Parameters<Parameters<Db["transaction"]>[0]>[0];
type IssueInterruptionApi = ReturnType<typeof heartbeatService>["issueInterruption"];
type ContinuationResult = Awaited<ReturnType<IssueInterruptionApi["selectContinuationInTransaction"]>>;
type DispatchableContinuation =
  | Extract<NonNullable<ContinuationResult>, { kind: "promoted" }>
  | Extract<NonNullable<ContinuationResult>, { kind: "queued_recovery" }>;

export type IssueInterruptionKind = "board_interrupt" | "scheduled_retry_supersession";

const RECEIPT_UNIQUE_VIOLATION = "23505";
const MAX_ESCALATION_PASSES = 2;

export type InterruptionCompletionSummary = {
  scanned: number;
  completed: number;
  continuationsQueued: number;
  noContinuationNeeded: number;
  blockedPending: number;
  skippedClaimedElsewhere: number;
  failed: number;
};

export type IssueInterruptionService = {
  /**
   * Composite-operation cancellation, executed inside the caller's issue
   * mutation transaction. Validates that the prepared run is still the one the
   * locked issue names, conditionally terminalizes it, and stops its owned
   * process group. Refuses to supersede a scheduled retry that already became
   * active; reports an outcome that already won instead of overwriting it.
   */
  cancelRunForCompositeIssueUpdate(
    executor: Executor,
    input: {
      issue: IssueRow;
      run: HeartbeatRunRow;
      kind: IssueInterruptionKind;
      reason: string;
      options: {
        errorCode?: string;
        resultJson?: Record<string, unknown>;
        eventMessage?: string;
        eventPayload?: Record<string, unknown>;
      };
    },
  ): Promise<{ cancelledRunId: string | null; childOutcomeWon: boolean }>;

  /**
   * Inserts the durable continuation receipt that only exists because the
   * cancellation and the requested issue mutation/comment are committing
   * together. One receipt per complete company/issue/run tuple.
   */
  insertPendingInterruptionReceipt(
    executor: Executor,
    input: {
      operationId: string;
      companyId: string;
      issueId: string;
      cancelledRunId: string;
      kind: IssueInterruptionKind;
    },
  ): Promise<void>;

  /**
   * Completes pending receipts: each completion transaction claims one row with
   * `FOR UPDATE SKIP LOCKED`, selects the native continuation against the
   * current committed issue state, records the outcome and consumes the receipt
   * in the same transaction. Repeated or concurrent reconcilers cannot select a
   * second replacement for a receipt. Explicit single-receipt mode (used by the
   * issuing request) rethrows per-receipt failures; page mode isolates them and
   * leaves the receipt pending and inspectable.
   */
  completePendingInterruptions(
    input?: { operationId?: string; limit?: number; reason?: string },
  ): Promise<InterruptionCompletionSummary>;

  /**
   * Startup/periodic entry point. Honors heartbeat scheduling suppression:
   * while suppressed, pending receipts stay untouched and inspectable and no
   * wall-clock completion is promised.
   */
  reconcilePendingInterruptions(
    input?: { limit?: number },
  ): Promise<{ suppressed: boolean } & InterruptionCompletionSummary>;

  getPendingReceipts(limit?: number): Promise<Array<{
    id: string;
    companyId: string;
    issueId: string;
    cancelledRunId: string;
    kind: IssueInterruptionKind;
  }>>;
};

export function createIssueInterruptionService(
  db: Db,
  deps: { heartbeat: Pick<ReturnType<typeof heartbeatService>, "issueInterruption" | "resolveSchedulingSuppression"> },
): IssueInterruptionService {
  const { heartbeat } = deps;

  async function cancelRunForCompositeIssueUpdate(
    executor: Executor,
    input: {
      issue: IssueRow;
      run: HeartbeatRunRow;
      kind: IssueInterruptionKind;
      reason: string;
      options: {
        errorCode?: string;
        resultJson?: Record<string, unknown>;
        eventMessage?: string;
        eventPayload?: Record<string, unknown>;
      };
    },
  ): Promise<{ cancelledRunId: string | null; childOutcomeWon: boolean }> {
    const { issue, run, kind } = input;
    if (run.companyId !== issue.companyId) {
      throw conflict("Interruption run does not belong to this company", {
        code: "issue_interruption_run_not_owned",
      });
    }
    // The exact candidate run must still be the one the locked issue names.
    if (issue.checkoutRunId !== run.id && issue.executionRunId !== run.id) {
      throw conflict("Interruption run is no longer named by the issue execution pointers", {
        code: "issue_interruption_run_not_owned",
      });
    }
    if (kind === "scheduled_retry_supersession" && run.status === "running") {
      // A retry that already became active requires explicit revalidation, not
      // implicit permission to interrupt live work.
      throw conflict("Scheduled retry already started; revalidate the issue before superseding it", {
        code: "issue_interruption_retry_already_active",
      });
    }
    if (run.status !== "queued" && run.status !== "running" && run.status !== "scheduled_retry") {
      // The run reached a terminal outcome before the cancellation CAS; that
      // outcome wins and is preserved, never overwritten.
      return { cancelledRunId: null, childOutcomeWon: true };
    }

    const cancellation = await heartbeat.issueInterruption.cancelRunInTransaction(executor, run, {
      reason: input.reason,
      requiredStatus: run.status,
      errorCode: input.options.errorCode,
      resultJson: input.options.resultJson,
      eventMessage: input.options.eventMessage,
      eventPayload: input.options.eventPayload,
    });
    if (!cancellation.cancelled || !cancellation.run) {
      const currentStatus = cancellation.run?.status;
      if (
        currentStatus === "queued" ||
        currentStatus === "running" ||
        currentStatus === "scheduled_retry"
      ) {
        // The CAS missed because the run moved to another still-live status
        // (e.g. a scheduled retry promoted to queued) — revalidate, never
        // silently skip cancellation while the run proceeds.
        throw conflict("Interruption run changed status; revalidate the issue before retrying", {
          code: "issue_interruption_run_state_conflict",
        });
      }
      // A terminal outcome already won before the cancellation CAS; preserve it
      // and let the caller's locked snapshot comparison revalidate the issue.
      return { cancelledRunId: null, childOutcomeWon: true };
    }

    // Physical termination is an irreversible external effect confined to the
    // already-cancelled exact run. It happens while the transaction is open but
    // must never be rolled back: if persistence after this point fails, the
    // transaction rolls back and native stopped-process recovery handles the
    // still-running row.
    await heartbeat.issueInterruption.stopRunProcess(cancellation.run);
    return { cancelledRunId: cancellation.run.id, childOutcomeWon: false };
  }

  async function insertPendingInterruptionReceipt(
    executor: Executor,
    input: {
      operationId: string;
      companyId: string;
      issueId: string;
      cancelledRunId: string;
      kind: IssueInterruptionKind;
    },
  ): Promise<void> {
    try {
      await executor.insert(issueInterruptions).values({
        id: input.operationId,
        companyId: input.companyId,
        issueId: input.issueId,
        cancelledRunId: input.cancelledRunId,
        kind: input.kind,
        state: "pending",
      });
    } catch (error) {
      const pgCode = (error as { code?: string }).code
        ?? ((error as { cause?: { code?: string } }).cause?.code);
      if (pgCode === RECEIPT_UNIQUE_VIOLATION) {
        throw conflict("An interruption receipt already exists for this issue and run", {
          code: "issue_interruption_receipt_exists",
        });
      }
      throw error;
    }
  }

  type SingleReceiptOutcome = "queued" | "noop" | "skipped" | "blocked_pending";

  async function completeSingleReceipt(receipt: {
    id: string;
    companyId: string;
    issueId: string;
    cancelledRunId: string;
  }): Promise<SingleReceiptOutcome> {
    for (let attempt = 1; attempt <= MAX_ESCALATION_PASSES; attempt += 1) {
      type CompletionDecision =
        | { kind: "claimed_elsewhere" }
        | { kind: "blocked"; promotionResult: NonNullable<ContinuationResult>; cancelledRun: HeartbeatRunRow }
        | { kind: "completed"; dispatchable: DispatchableContinuation | null; cancelledRun: HeartbeatRunRow | null };

      const decision: CompletionDecision = await db.transaction(async (tx) => {
        const claimed = await tx
          .select()
          .from(issueInterruptions)
          .where(and(eq(issueInterruptions.id, receipt.id), eq(issueInterruptions.state, "pending")))
          .for("update", { skipLocked: true })
          .then((rows) => rows[0] ?? null);
        if (!claimed) return { kind: "claimed_elsewhere" };

        // Trust only the server-created receipt linkage, then independently
        // scope every current-state read to the receipt's company and issue.
        const issue = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.companyId, claimed.companyId), eq(issues.id, claimed.issueId)))
          .then((rows) => rows[0] ?? null);
        const cancelledRun = issue
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.companyId, claimed.companyId), eq(heartbeatRuns.id, claimed.cancelledRunId)))
            .then((rows) => rows[0] ?? null)
          : null;
        if (!issue || !cancelledRun) {
          // Parent deletion cascades the receipt; a surviving pending row
          // without its parents is completed as a verified no-op that
          // dispatches nothing.
          await tx
            .update(issueInterruptions)
            .set({ state: "completed", outcome: "no_continuation_needed", updatedAt: new Date() })
            .where(eq(issueInterruptions.id, claimed.id));
          return { kind: "completed", dispatchable: null, cancelledRun: null };
        }
        if (cancelledRun.status !== "cancelled") {
          throw conflict("Interruption receipt no longer names a cancelled run", {
            code: "issue_interruption_run_state_conflict",
          });
        }

        const continuationResult = await heartbeat.issueInterruption.selectContinuationInTransaction(tx, cancelledRun);
        if (
          continuationResult &&
          (continuationResult.kind === "blocked" || continuationResult.kind === "blocked_recovery_in_place")
        ) {
          // Do not consume the receipt before the required durable escalation
          // effect exists; escalate after this transaction commits, then
          // re-evaluate in a bounded later pass.
          return { kind: "blocked", promotionResult: continuationResult, cancelledRun };
        }
        const dispatchable =
          continuationResult &&
          (continuationResult.kind === "promoted" || continuationResult.kind === "queued_recovery")
            ? continuationResult
            : null;
        await tx
          .update(issueInterruptions)
          .set({
            state: "completed",
            outcome: dispatchable ? "continuation_queued" : "no_continuation_needed",
            continuationRunId: dispatchable?.run.id ?? null,
            updatedAt: new Date(),
          })
          // The receipt is consumed in the SAME transaction that records the
          // selected continuation, so a repeated reconciler can never select a
          // second replacement.
          .where(and(eq(issueInterruptions.id, claimed.id), eq(issueInterruptions.state, "pending")));
        return { kind: "completed", dispatchable, cancelledRun };
      });

      if (decision.kind === "claimed_elsewhere") return "skipped";
      if (decision.kind === "blocked") {
        await heartbeat.issueInterruption.escalateBlockedContinuation(decision.promotionResult, decision.cancelledRun);
        continue;
      }
      if (!decision.cancelledRun) return "noop";
      await heartbeat.issueInterruption.dispatchContinuation(decision.cancelledRun, decision.dispatchable);
      return decision.dispatchable ? "queued" : "noop";
    }
    return "blocked_pending";
  }

  async function completePendingInterruptions(
    input: { operationId?: string; limit?: number; reason?: string } = {},
  ): Promise<InterruptionCompletionSummary> {
    const summary: InterruptionCompletionSummary = {
      scanned: 0,
      completed: 0,
      continuationsQueued: 0,
      noContinuationNeeded: 0,
      blockedPending: 0,
      skippedClaimedElsewhere: 0,
      failed: 0,
    };
    const receipts = await db
      .select({
        id: issueInterruptions.id,
        companyId: issueInterruptions.companyId,
        issueId: issueInterruptions.issueId,
        cancelledRunId: issueInterruptions.cancelledRunId,
      })
      .from(issueInterruptions)
      .where(
        input.operationId
          ? and(eq(issueInterruptions.id, input.operationId), eq(issueInterruptions.state, "pending"))
          : eq(issueInterruptions.state, "pending"),
      )
      .orderBy(asc(issueInterruptions.createdAt))
      .limit(input.operationId ? 1 : (input.limit ?? 25));

    for (const receipt of receipts) {
      summary.scanned += 1;
      try {
        const outcome = await completeSingleReceipt(receipt);
        if (outcome === "skipped") {
          summary.skippedClaimedElsewhere += 1;
        } else if (outcome === "queued") {
          summary.completed += 1;
          summary.continuationsQueued += 1;
        } else if (outcome === "noop") {
          summary.completed += 1;
          summary.noContinuationNeeded += 1;
        } else {
          summary.blockedPending += 1;
        }
      } catch (error) {
        if (input.operationId) throw error;
        // Page mode must not let one broken receipt block the others; the
        // pending row stays inspectable and the next pass retries it.
        summary.failed += 1;
        logger.warn(
          { err: error, receiptId: receipt.id, reason: input.reason },
          "issue interruption continuation failed; pending receipt remains",
        );
      }
    }
    return summary;
  }

  async function reconcilePendingInterruptions(
    input: { limit?: number } = {},
  ): Promise<{ suppressed: boolean } & InterruptionCompletionSummary> {
    const suppression = await heartbeat.resolveSchedulingSuppression();
    if (suppression.suppressed) {
      return {
        suppressed: true,
        scanned: 0,
        completed: 0,
        continuationsQueued: 0,
        noContinuationNeeded: 0,
        blockedPending: 0,
        skippedClaimedElsewhere: 0,
        failed: 0,
      };
    }
    const summary = await completePendingInterruptions({ limit: input.limit ?? 25, reason: "reconcile" });
    return { suppressed: false, ...summary };
  }

  async function getPendingReceipts(limit = 100) {
    return db
      .select({
        id: issueInterruptions.id,
        companyId: issueInterruptions.companyId,
        issueId: issueInterruptions.issueId,
        cancelledRunId: issueInterruptions.cancelledRunId,
        kind: issueInterruptions.kind,
      })
      .from(issueInterruptions)
      .where(eq(issueInterruptions.state, "pending"))
      .orderBy(asc(issueInterruptions.createdAt))
      .limit(limit) as Promise<Array<{
        id: string;
        companyId: string;
        issueId: string;
        cancelledRunId: string;
        kind: IssueInterruptionKind;
      }>>;
  }

  return {
    cancelRunForCompositeIssueUpdate,
    insertPendingInterruptionReceipt,
    completePendingInterruptions,
    reconcilePendingInterruptions,
    getPendingReceipts,
  };
}
