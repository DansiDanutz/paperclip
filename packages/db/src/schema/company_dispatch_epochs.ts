import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * The single durable dispatch epoch per company. Exactly one live epoch names
 * the one server-fenced dispatcher; primary recovery invalidates the row and
 * the monotonic epoch counter prevents a superseded standby from renewing.
 */
export const companyDispatchEpochs = pgTable(
  "company_dispatch_epochs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    epoch: integer("epoch").notNull(),
    ownerInstanceId: text("owner_instance_id").notNull(),
    state: text("state").notNull().default("active"),
    dispatchCount: integer("dispatch_count").notNull().default(0),
    maxDispatches: integer("max_dispatches").notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull().defaultNow(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // At most one live epoch per company: the single server-fenced dispatcher.
    companyActiveUq: uniqueIndex("company_dispatch_epochs_company_active_uq")
      .on(table.companyId)
      .where(sql`${table.state} = 'active'`),
    stateCheck: check(
      "company_dispatch_epochs_state_check",
      sql`${table.state} in ('active', 'invalidated', 'expired')`,
    ),
    companyStateIdx: index("company_dispatch_epochs_company_state_idx").on(
      table.companyId,
      table.state,
    ),
  }),
);
