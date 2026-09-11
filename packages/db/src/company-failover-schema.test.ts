import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { companyDispatchEpochs } from "./schema/company_dispatch_epochs.js";
import { companyFailoverPolicies } from "./schema/company_failover_policies.js";

type ForeignKeyConfig = {
  reference(): { foreignTable: Parameters<typeof getTableName>[0] };
  onDelete?: string;
};

describe("company failover admission schema", () => {
  const policyConfig = getTableConfig(companyFailoverPolicies);
  const epochConfig = getTableConfig(companyDispatchEpochs);
  const policyColumns = policyConfig.columns;
  const epochColumns = epochConfig.columns;

  it("stores one typed policy row per company with a revision and disabled default", () => {
    expect(policyColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "company_id", "policy", "policy_revision", "enabled",
    ]));
    const enabled = policyColumns.find((column) => column.name === "enabled");
    expect(enabled?.hasDefault).toBe(true);
    const companyUnique = (policyConfig as unknown as {
      uniqueConstraints: Array<{ name: string; columns: Array<{ name: string }> }>;
    }).uniqueConstraints.map((constraint) => constraint.columns.map((column) => column.name));
    expect(companyUnique).toContainEqual(["company_id"]);
  });

  it("keeps the policy document as jsonb", () => {
    expect(policyColumns.find((column) => column.name === "policy")?.columnType).toBe("PgJsonb");
  });

  it("stores one durable epoch row per company with monotonic epoch, owner binding and expiry", () => {
    expect(epochColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "company_id", "epoch", "owner_instance_id", "state", "dispatch_count",
      "max_dispatches", "admitted_at", "renewed_at", "expires_at", "invalidated_at", "invalidation_reason",
    ]));
    const epochColumn = epochColumns.find((column) => column.name === "epoch");
    expect(epochColumn?.notNull).toBe(true);
    const stateColumn = epochColumns.find((column) => column.name === "state");
    expect(stateColumn?.hasDefault).toBe(true);
  });

  it("constrains epoch state values and one live epoch per company", () => {
    const epochChecks = (epochConfig.checks as Array<{ name: string }>).map((candidate) => candidate.name);
    expect(epochChecks).toContain("company_dispatch_epochs_state_check");
    const epochIndexes = epochConfig.indexes.map((candidate) => ({
      name: candidate.config?.name,
      unique: (candidate.config as { unique?: boolean } | undefined)?.unique === true,
    }));
    expect(epochIndexes.some((candidate) => candidate.unique && candidate.name === "company_dispatch_epochs_company_active_uq")).toBe(true);
  });

  it("cascades both tables to their company parent", () => {
    for (const config of [policyConfig, epochConfig]) {
      const foreignKeys = config.foreignKeys as unknown as Array<{
        reference(): { foreignTable: Parameters<typeof getTableName>[0] };
        onDelete?: string;
      }>;
      expect(foreignKeys.length).toBeGreaterThanOrEqual(1);
      for (const key of foreignKeys) {
        expect(getTableName(key.reference().foreignTable)).toBe("companies");
        expect(key.onDelete).toBe("cascade");
      }
    }
  });
});
