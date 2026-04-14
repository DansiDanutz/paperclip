// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueWorkProductsPanel } from "./IssueWorkProductsPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue work products",
    description: null,
    status: "in_progress",
    priority: "high",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 884,
    identifier: "PAP-884",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: "workspace-1",
    executionWorkspacePreference: "isolated_workspace",
    executionWorkspaceSettings: { mode: "isolated_workspace" },
    currentExecutionWorkspace: {
      id: "workspace-1",
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: null,
      sourceIssueId: "issue-1",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "PAP-884-ai-commits-component",
      status: "active",
      cwd: "/tmp/pap-884",
      repoUrl: "https://github.com/example/paperclip",
      baseRef: "main",
      branchName: "PAP-884-ai-commits-component",
      providerType: "git_worktree",
      providerRef: null,
      derivedFromExecutionWorkspaceId: null,
      lastUsedAt: new Date("2026-04-14T07:00:00.000Z"),
      openedAt: new Date("2026-04-14T06:00:00.000Z"),
      closedAt: null,
      cleanupEligibleAt: null,
      cleanupReason: null,
      config: null,
      metadata: null,
      runtimeServices: [],
      createdAt: new Date("2026-04-14T06:00:00.000Z"),
      updatedAt: new Date("2026-04-14T07:00:00.000Z"),
    },
    workProducts: [
      {
        id: "commit-1",
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        executionWorkspaceId: "workspace-1",
        runtimeServiceId: null,
        type: "commit",
        provider: "github",
        externalId: "abc1234",
        title: "Fix issue detail AI commit rendering",
        url: "https://github.com/example/paperclip/commit/abc1234",
        status: "active",
        reviewState: "none",
        isPrimary: true,
        healthStatus: "healthy",
        summary: "Adds the missing work product list to the issue detail page.",
        metadata: { branchName: "PAP-884-ai-commits-component", commitSha: "abc1234" },
        createdByRunId: "run-1",
        createdAt: new Date("2026-04-14T06:10:00.000Z"),
        updatedAt: new Date("2026-04-14T07:05:00.000Z"),
      },
      {
        id: "preview-1",
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        executionWorkspaceId: "workspace-1",
        runtimeServiceId: null,
        type: "preview_url",
        provider: "vercel",
        externalId: null,
        title: "Issue detail preview",
        url: "https://paperclip-preview.vercel.app",
        status: "ready_for_review",
        reviewState: "needs_board_review",
        isPrimary: false,
        healthStatus: "healthy",
        summary: "Preview deployment for the new issue detail tab.",
        metadata: { previewUrl: "https://paperclip-preview.vercel.app" },
        createdByRunId: "run-1",
        createdAt: new Date("2026-04-14T06:15:00.000Z"),
        updatedAt: new Date("2026-04-14T07:10:00.000Z"),
      },
      {
        id: "doc-1",
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        executionWorkspaceId: "workspace-1",
        runtimeServiceId: null,
        type: "document",
        provider: "paperclip",
        externalId: null,
        title: "Implementation notes",
        url: null,
        status: "draft",
        reviewState: "none",
        isPrimary: false,
        healthStatus: "unknown",
        summary: null,
        metadata: null,
        createdByRunId: "run-1",
        createdAt: new Date("2026-04-14T06:20:00.000Z"),
        updatedAt: new Date("2026-04-14T07:15:00.000Z"),
      },
    ],
    startedAt: new Date("2026-04-14T06:00:00.000Z"),
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-14T06:00:00.000Z"),
    updatedAt: new Date("2026-04-14T07:15:00.000Z"),
    ...overrides,
  };
}

describe("IssueWorkProductsPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("groups issue work products into the expected sections", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<IssueWorkProductsPanel issue={createIssue()} />);
    });

    expect(container.textContent).toContain("Current workspace");
    expect(container.textContent).toContain("Previews");
    expect(container.textContent).toContain("Branches and commits");
    expect(container.textContent).toContain("Artifacts and documents");
    expect(container.textContent).toContain("Fix issue detail AI commit rendering");
    expect(container.textContent).toContain("Issue detail preview");
    expect(container.textContent).toContain("Implementation notes");

    act(() => {
      root.unmount();
    });
  });
});
