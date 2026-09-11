import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { issueInterruptions } from "./schema/issue_interruptions.js";

type ForeignKeyConfig = {
  reference(): {
    foreignTable: Parameters<typeof getTableName>[0];
    columns: Array<{ name: string }>;
    foreignColumns: Array<{ name: string }>;
  };
  onDelete?: string;
};

describe("issue interruption receipt schema", () => {
  const tableConfig = getTableConfig(issueInterruptions);
  const indexes = tableConfig.indexes;
  const checks = tableConfig.checks;
  const foreignKeys = tableConfig.foreignKeys as unknown as ForeignKeyConfig[];
  const uniqueConstraints = (
    tableConfig as unknown as { uniqueConstraints: Array<{ name: string; columns: Array<{ name: string }> }> }
  ).uniqueConstraints;

  it("enforces one receipt per complete company/issue/run tuple", () => {
    const tuple = uniqueConstraints.find(
      (candidate) => candidate.name === "issue_interruptions_company_issue_run_uq",
    );
    expect(tuple?.columns.map((column) => column.name)).toEqual([
      "company_id",
      "issue_id",
      "cancelled_run_id",
    ]);
  });

  it("binds company and issue together through the verified compound issue identity", () => {
    const compound = foreignKeys.find(
      (key) => getTableName(key.reference().foreignTable) === "issues",
    );
    expect(compound).toBeDefined();
    const reference = compound!.reference();
    expect(reference.columns.map((column) => column.name)).toEqual(["company_id", "issue_id"]);
    expect(reference.foreignColumns.map((column) => column.name)).toEqual(["company_id", "id"]);
  });

  it("cascades deletion to the issue, company and both run parents", () => {
    const referencedTables = foreignKeys.map((key) => getTableName(key.reference().foreignTable)).sort();
    expect(referencedTables).toEqual(["companies", "heartbeat_runs", "heartbeat_runs", "issues"]);
    for (const key of foreignKeys) {
      expect(key.onDelete).toBe("cascade");
    }
  });

  it("restricts kind, state and outcome values with database checks", () => {
    const checkNames = checks.map((candidate) => candidate.name);
    expect(checkNames).toContain("issue_interruptions_kind_check");
    expect(checkNames).toContain("issue_interruptions_state_check");
    expect(checkNames).toContain("issue_interruptions_outcome_check");
  });

  it("pairs the pending state with no recorded outcome and completed with one", () => {
    const checkNames = checks.map((candidate) => candidate.name);
    expect(checkNames).toContain("issue_interruptions_pending_outcome_pairing_check");
    expect(checkNames).toContain("issue_interruptions_continuation_pairing_check");
  });

  it("indexes pending receipts for bounded page scans", () => {
    const pending = indexes.find(
      (candidate) => candidate.config.name === "issue_interruptions_pending_created_idx",
    );
    expect(pending).toBeDefined();
    expect(pending!.config.unique).toBe(false);
  });
});
