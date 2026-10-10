function read(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Wake payload for a plugin `agents.invoke`.
 *
 * Proposal runs pass `taskKey` and `escalationCwd` and omit `issueId`.
 * An issue id takes the issue execution lock and defers every other wake
 * for that issue, so a second proposal is dropped.
 */
export function buildPluginAgentInvokeWake(params: {
  prompt: string;
  reason?: string | null;
  issueId?: string | null;
  taskKey?: string | null;
  escalationCwd?: string | null;
}): {
  payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
} {
  const issueId = read(params.issueId);
  const taskKey = read(params.taskKey);
  const escalationCwd = read(params.escalationCwd);
  return {
    payload: {
      prompt: params.prompt,
      ...(issueId ? { issueId } : {}),
      ...(taskKey ? { taskKey } : {}),
    },
    contextSnapshot: {
      ...(params.reason ? { wakeReason: params.reason } : {}),
      ...(issueId ? { issueId, taskId: issueId } : {}),
      ...(taskKey ? { taskKey } : {}),
      ...(escalationCwd ? { escalationCwd } : {}),
      escalationPrompt: params.prompt,
    },
  };
}
