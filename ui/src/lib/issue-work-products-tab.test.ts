import type { Issue } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { shouldShowIssueWorkProductTab } from "./issue-work-products-tab";

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: "shared_workspace",
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    workProducts: [],
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-14T07:00:00.000Z"),
    updatedAt: new Date("2026-04-14T07:00:00.000Z"),
    ...overrides,
  };
}

describe("shouldShowIssueWorkProductTab", () => {
  it("shows the tab when isolated workspaces are enabled", () => {
    expect(shouldShowIssueWorkProductTab(createIssue(), true)).toBe(true);
  });

  it("shows the tab when the issue already has work products", () => {
    expect(
      shouldShowIssueWorkProductTab(
        createIssue({
          workProducts: [
            {
              id: "wp-1",
              companyId: "company-1",
              projectId: null,
              issueId: "issue-1",
              executionWorkspaceId: null,
              runtimeServiceId: null,
              type: "commit",
              provider: "github",
              externalId: "abc123",
              title: "Commit",
              url: null,
              status: "active",
              reviewState: "none",
              isPrimary: false,
              healthStatus: "unknown",
              summary: null,
              metadata: null,
              createdByRunId: null,
              createdAt: new Date("2026-04-14T07:00:00.000Z"),
              updatedAt: new Date("2026-04-14T07:00:00.000Z"),
            },
          ],
        }),
        false,
      ),
    ).toBe(true);
  });

  it("shows the tab when the issue has a current execution workspace, even without work products", () => {
    expect(
      shouldShowIssueWorkProductTab(
        createIssue({
          currentExecutionWorkspace: {
            id: "workspace-1",
            companyId: "company-1",
            projectId: "project-1",
            projectWorkspaceId: null,
            sourceIssueId: "issue-1",
            mode: "isolated_workspace",
            strategyType: "git_worktree",
            name: "workspace",
            status: "active",
            cwd: "/tmp/workspace",
            repoUrl: null,
            baseRef: "main",
            branchName: "feature/workspace",
            providerType: "git_worktree",
            providerRef: null,
            derivedFromExecutionWorkspaceId: null,
            lastUsedAt: new Date("2026-04-14T07:00:00.000Z"),
            openedAt: new Date("2026-04-14T07:00:00.000Z"),
            closedAt: null,
            cleanupEligibleAt: null,
            cleanupReason: null,
            config: null,
            metadata: null,
            runtimeServices: [],
            createdAt: new Date("2026-04-14T07:00:00.000Z"),
            updatedAt: new Date("2026-04-14T07:00:00.000Z"),
          },
        }),
        false,
      ),
    ).toBe(true);
  });

  it("hides the tab when the issue has no work products or active workspace and the flag is off", () => {
    expect(shouldShowIssueWorkProductTab(createIssue(), false)).toBe(false);
  });
});
