import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Typed, disabled-by-default failover admission policy. The policy document is
 * installed through the authorized setter path only; an absent, invalid, or
 * incomplete document is a fixed admission_not_configured condition — never
 * default-healthy. No production values exist in this file.
 */
export const companyFailoverPolicies = pgTable(
  "company_failover_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    policyRevision: text("policy_revision").notNull(),
    enabled: text("enabled").notNull().default("false"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: unique("company_failover_policies_company_uq").on(table.companyId),
    enabledCheck: check(
      "company_failover_policies_enabled_check",
      sql`${table.enabled} in ('true', 'false')`,
    ),
  }),
);
