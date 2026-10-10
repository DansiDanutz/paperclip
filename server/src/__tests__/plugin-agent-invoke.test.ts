import { describe, expect, it } from "vitest";
import { buildPluginAgentInvokeWake } from "../services/plugin-agent-invoke.ts";

describe("plugin agent invoke wake", () => {
  it("omits the issue id so a proposal does not take the execution lock", () => {
    const wake = buildPluginAgentInvokeWake({
      prompt: "proposal",
      reason: "error_escalation_proposal",
      taskKey: "error-escalation:esc:kimi",
      escalationCwd: "/tmp/paperclip-escalation/worktree",
    });
    expect(wake.payload).not.toHaveProperty("issueId");
    expect(wake.contextSnapshot).not.toHaveProperty("issueId");
    expect(wake.contextSnapshot).not.toHaveProperty("taskId");
    expect(wake.contextSnapshot.taskKey).toBe("error-escalation:esc:kimi");
    expect(wake.contextSnapshot.escalationCwd).toBe("/tmp/paperclip-escalation/worktree");
    expect(wake.contextSnapshot.wakeReason).toBe("error_escalation_proposal");
  });

  it("still forwards an explicit issue id for other callers", () => {
    const wake = buildPluginAgentInvokeWake({
      prompt: "wake",
      issueId: "issue-1",
    });
    expect(wake.payload.issueId).toBe("issue-1");
    expect(wake.contextSnapshot.issueId).toBe("issue-1");
    expect(wake.contextSnapshot.taskId).toBe("issue-1");
  });
});
