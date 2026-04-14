import type { Issue } from "@paperclipai/shared";

export function shouldShowIssueWorkProductTab(
  issue: Issue | null | undefined,
  isolatedWorkspacesEnabled: boolean,
) {
  return (
    isolatedWorkspacesEnabled ||
    issue?.currentExecutionWorkspace != null ||
    (issue?.workProducts?.length ?? 0) > 0
  );
}
