import { describe, expect, it } from "vitest";
import {
  ERROR_ESCALATION_PROPOSAL_WAKE_REASON,
  TERMINAL_RUN_ACTIVITY_EXCERPT_CHARS,
  buildTerminalRunActivityDetails,
  isEscalationProposalWake,
  shouldPublishTerminalRunActivity,
  terminalRunActivityAction,
  truncateActivityExcerpt,
} from "../services/terminal-run-activity.ts";

describe("terminal run activity", () => {
  it("maps terminal heartbeat statuses onto plugin event names", () => {
    expect(terminalRunActivityAction("succeeded")).toBe("agent.run.finished");
    expect(terminalRunActivityAction("failed")).toBe("agent.run.failed");
    expect(terminalRunActivityAction("timed_out")).toBe("agent.run.failed");
    expect(terminalRunActivityAction("cancelled")).toBe("agent.run.cancelled");
    expect(terminalRunActivityAction("running")).toBeNull();
    expect(terminalRunActivityAction("queued")).toBeNull();
  });

  it("emits a terminal activity once when the same action is written again", () => {
    expect(shouldPublishTerminalRunActivity("running", "cancelled")).toBe(true);
    expect(shouldPublishTerminalRunActivity("cancelled", "cancelled")).toBe(false);
    expect(shouldPublishTerminalRunActivity("succeeded", "succeeded")).toBe(false);
    expect(shouldPublishTerminalRunActivity(null, "failed")).toBe(true);
    expect(shouldPublishTerminalRunActivity("running", "running")).toBe(false);
  });

  it("marks only the proposal wake reason", () => {
    expect(isEscalationProposalWake({ wakeReason: ERROR_ESCALATION_PROPOSAL_WAKE_REASON })).toBe(true);
    expect(isEscalationProposalWake({ wakeReason: "issue_assigned" })).toBe(false);
    expect(isEscalationProposalWake(null)).toBe(false);
  });

  it("keeps the tail of long excerpts and copies workspace fields", () => {
    const long = `${"a".repeat(TERMINAL_RUN_ACTIVITY_EXCERPT_CHARS)}TAIL`;
    expect(truncateActivityExcerpt(long)).toBe(long.slice(long.length - TERMINAL_RUN_ACTIVITY_EXCERPT_CHARS));
    expect(truncateActivityExcerpt("")).toBeNull();

    const details = buildTerminalRunActivityDetails({
      runId: "run-1",
      agentId: "agent-1",
      adapterType: "process",
      status: "failed",
      error: "boom",
      errorCode: "adapter_failed",
      exitCode: 1,
      stdoutExcerpt: "out",
      stderrExcerpt: long,
      contextSnapshot: {
        issueId: "issue-1",
        wakeReason: ERROR_ESCALATION_PROPOSAL_WAKE_REASON,
        paperclipWorkspace: {
          repoUrl: "https://github.com/DansiDanutz/paperclip",
          repoRef: "master",
          branchName: "fix",
          cwd: "/tmp/repo",
        },
      },
    });
    expect(details.escalationProposal).toBe(true);
    expect(details.repoUrl).toBe("https://github.com/DansiDanutz/paperclip");
    expect(details.branchName).toBe("fix");
    expect(details.cwd).toBe("/tmp/repo");
    expect(details.stderrExcerpt?.endsWith("TAIL")).toBe(true);
    expect(details.stderrExcerpt?.length).toBe(TERMINAL_RUN_ACTIVITY_EXCERPT_CHARS);
  });
});
