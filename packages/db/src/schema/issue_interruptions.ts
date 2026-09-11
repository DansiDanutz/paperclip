import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Durable continuation receipt for a coordinated operator issue interruption.
 *
 * A row exists only when the exact run cancellation and the operator's requested
 * issue mutation/comment committed together; pending rows are continuation work
 * the server owes the issue after its own restart. The record never stores a
 * request body, comment contents, credentials or an invented replay response,
 * and adapter/request-origin metadata cannot create or complete one.
 */
export const issueInterruptions = pgTable(
  "issue_interruptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    cancelledRunId: uuid("cancelled_run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("pending"),
    outcome: text("outcome"),
    continuationRunId: uuid("continuation_run_id").references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One receipt per complete company/issue/run tuple.
    companyIssueRunUq: unique("issue_interruptions_company_issue_run_uq").on(
      table.companyId,
      table.issueId,
      table.cancelledRunId,
    ),
    // Structural company/issue linkage through the verified issues_company_id_uq
    // compound identity; deleting the issue (or its company) removes the receipt,
    // so a pending receipt can never block an authorized deletion.
    companyIssueFk: foreignKey({
      name: "issue_interruptions_company_issue_fk",
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
    }).onDelete("cascade"),
    // Bounded pending-page scans in creation order.
    pendingCreatedIdx: index("issue_interruptions_pending_created_idx")
      .on(table.createdAt)
      .where(sql`${table.state} = 'pending'`),
    companyIssueIdx: index("issue_interruptions_company_issue_idx").on(table.companyId, table.issueId),
    kindCheck: check(
      "issue_interruptions_kind_check",
      sql`${table.kind} in ('board_interrupt', 'scheduled_retry_supersession')`,
    ),
    stateCheck: check(
      "issue_interruptions_state_check",
      sql`${table.state} in ('pending', 'completed')`,
    ),
    outcomeCheck: check(
      "issue_interruptions_outcome_check",
      sql`${table.outcome} is null or ${table.outcome} in ('continuation_queued', 'no_continuation_needed', 'blocked_escalation_required')`,
    ),
    pendingOutcomePairingCheck: check(
      "issue_interruptions_pending_outcome_pairing_check",
      sql`(${table.state} = 'pending' and ${table.outcome} is null and ${table.continuationRunId} is null)
        or (${table.state} = 'completed' and ${table.outcome} is not null)`,
    ),
    continuationPairingCheck: check(
      "issue_interruptions_continuation_pairing_check",
      sql`(${table.outcome} = 'continuation_queued') = (${table.continuationRunId} is not null)`,
    ),
  }),
);
