import { describe, expect, it } from "vitest";
import { resolvePluginBridgeCompanyScope } from "../services/plugin-bridge-scope.ts";

describe("plugin bridge company scope", () => {
  it("replaces a nested company id with the authorized one", () => {
    const scope = resolvePluginBridgeCompanyScope({
      companyId: "company-a",
      params: { companyId: "company-b", issueId: "issue-1" },
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.companyId).toBe("company-a");
    expect(scope.params.companyId).toBe("company-a");
    expect(scope.params.issueId).toBe("issue-1");
  });

  it("does not add a company id to params that did not name one", () => {
    const scope = resolvePluginBridgeCompanyScope({
      companyId: "company-a",
      params: { issueId: "issue-1" },
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.companyId).toBe("company-a");
    expect(scope.params).toEqual({ issueId: "issue-1" });
  });

  it("does not promote a nested company id into the authorized scope", () => {
    const scope = resolvePluginBridgeCompanyScope({
      params: { companyId: "company-b" },
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.companyId).toBeNull();
    expect(scope.params.companyId).toBe("company-b");
  });
});
