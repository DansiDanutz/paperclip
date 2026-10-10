import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAdapterExecutionCwd } from "@paperclipai/adapter-utils/server-utils";

const claudeExecute = readFileSync(new URL("../../../claude-local/src/server/execute.ts", import.meta.url), "utf8");
const codexExecute = readFileSync(new URL("./execute.ts", import.meta.url), "utf8");
const heartbeat = readFileSync(new URL("../../../../../server/src/services/heartbeat.ts", import.meta.url), "utf8");

const ISOLATED = "/tmp/paperclip-escalation-abc/worktree";
const CONFIGURED = "/srv/real-checkout";

function proposalContext(extra: Record<string, unknown> = {}) {
  return {
    escalationCwd: ISOLATED,
    paperclipWorkspace: {
      cwd: ISOLATED,
      source: "agent_home",
      strategy: "git_worktree",
    },
    ...extra,
  };
}

describe("resolveAdapterExecutionCwd", () => {
  it("is the cwd decision Claude, Codex, and proposal heartbeats use", () => {
    expect(claudeExecute).toContain("resolveAdapterExecutionCwd(");
    expect(codexExecute).toContain("resolveAdapterExecutionCwd(");
    expect(heartbeat).toContain("cwd: escalationCwd");
  });

  it("uses the isolated worktree when a proposal agent has its own cwd", () => {
    const cwd = resolveAdapterExecutionCwd({
      config: { cwd: CONFIGURED },
      context: proposalContext(),
      fallbackCwd: "/fallback",
    });
    expect(cwd).toBe(ISOLATED);
  });

  it("uses the git worktree workspace when escalationCwd is absent", () => {
    const cwd = resolveAdapterExecutionCwd({
      config: { cwd: CONFIGURED },
      context: proposalContext({ escalationCwd: "  " }),
      fallbackCwd: "/fallback",
    });
    expect(cwd).toBe(ISOLATED);
  });

  it("still prefers a configured cwd for a normal agent_home workspace", () => {
    const cwd = resolveAdapterExecutionCwd({
      config: { cwd: CONFIGURED },
      context: {
        paperclipWorkspace: {
          cwd: "/home/agent",
          source: "agent_home",
          strategy: "project_primary",
        },
      },
      fallbackCwd: "/fallback",
    });
    expect(cwd).toBe(CONFIGURED);
  });
});
