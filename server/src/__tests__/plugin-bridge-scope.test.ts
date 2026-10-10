import { describe, expect, it } from "vitest";
import { resolvePluginBridgeCompanyScope } from "../services/plugin-bridge-scope.ts";

describe("plugin bridge company scope", () => {
  it("rejects a nested company id that differs from the authorized one", () => {
    const scope = resolvePluginBridgeCompanyScope({
      companyId: "company-a",
      params: { companyId: "company-b", issueId: "issue-1" },
    });
    expect(scope.ok).toBe(false);
  });

  it("stamps the authorized company id onto params", () => {
    const scope = resolvePluginBridgeCompanyScope({
      companyId: "company-a",
      params: { issueId: "issue-1" },
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.companyId).toBe("company-a");
    expect(scope.params.companyId).toBe("company-a");
    expect(scope.params.issueId).toBe("issue-1");
  });
});
