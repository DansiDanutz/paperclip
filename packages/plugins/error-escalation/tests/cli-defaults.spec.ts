import { describe, expect, it } from "vitest";
import { ESCALATION_PROMPT_ARG, PROPOSAL_CLI_DEFAULTS } from "../src/constants.js";

describe("proposal CLI defaults", () => {
  it("keeps the help-verified Claude and Codex flags", () => {
    expect(PROPOSAL_CLI_DEFAULTS.claude_local.extraArgs).toEqual(["--permission-mode", "plan"]);
    expect(PROPOSAL_CLI_DEFAULTS.codex_local.extraArgs).toEqual(["-s", "read-only"]);
    expect(PROPOSAL_CLI_DEFAULTS.claude_local.helpVerified).toBe(true);
    expect(PROPOSAL_CLI_DEFAULTS.codex_local.helpVerified).toBe(true);
    expect(PROPOSAL_CLI_DEFAULTS.claude_local.runtimeExercised).toBe(false);
    expect(PROPOSAL_CLI_DEFAULTS.codex_local.runtimeExercised).toBe(false);
  });

  it("defaults grok to -p and plan mode", () => {
    expect(PROPOSAL_CLI_DEFAULTS.grok_build.installedPath).toBe("~/.grok/bin/grok");
    expect(PROPOSAL_CLI_DEFAULTS.grok_build.args).toEqual([
      "-p",
      ESCALATION_PROMPT_ARG,
      "--permission-mode",
      "plan",
    ]);
    expect(PROPOSAL_CLI_DEFAULTS.grok_build.passWakePromptOnStdin).toBe(false);
    expect(PROPOSAL_CLI_DEFAULTS.grok_build.helpVerified).toBe(true);
    expect(PROPOSAL_CLI_DEFAULTS.grok_build.runtimeExercised).toBe(false);
  });

  it("defaults kimi to -p --plan and never includes yolo", () => {
    expect(PROPOSAL_CLI_DEFAULTS.kimi.installedPath).toBe("~/.kimi-code/bin/kimi");
    expect(PROPOSAL_CLI_DEFAULTS.kimi.args).toEqual(["-p", ESCALATION_PROMPT_ARG, "--plan"]);
    expect(PROPOSAL_CLI_DEFAULTS.kimi.args).not.toContain("-y");
    expect(PROPOSAL_CLI_DEFAULTS.kimi.args).not.toContain("--yolo");
    expect(PROPOSAL_CLI_DEFAULTS.kimi.forbiddenArgs).toEqual(["-y", "--yolo"]);
    expect(PROPOSAL_CLI_DEFAULTS.kimi.passWakePromptOnStdin).toBe(false);
    expect(PROPOSAL_CLI_DEFAULTS.kimi.helpVerified).toBe(true);
    expect(PROPOSAL_CLI_DEFAULTS.kimi.runtimeExercised).toBe(false);
  });
});
