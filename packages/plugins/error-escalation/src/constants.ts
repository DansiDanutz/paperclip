export const PLUGIN_ID = "paperclip.error-escalation";
export const PLUGIN_VERSION = "0.1.0";

/** OpenRouter router that only selects currently free models. */
export const DEFAULT_JUDGE_MODEL = "openrouter/free";

export const PROPOSAL_WAKE_REASON = "error_escalation_proposal";

export const HARNESS_ORDER = ["claude_local", "codex_local", "grok_build", "kimi"] as const;
export type HarnessId = (typeof HARNESS_ORDER)[number];

export const SLACK_APPROVE_ACTION = "error_escalation_approve";
export const SLACK_REJECT_ACTION = "error_escalation_reject";
export const SLACK_REJECT_CALLBACK = "error_escalation_reject_modal";

/** Exact argv token the process adapter replaces with the escalation prompt. */
export const ESCALATION_PROMPT_ARG = "{escalationPrompt}";

/**
 * CLI defaults for the four proposal agents.
 * Flag names were checked against `--help` on Dan's Mac. The commands have not been run.
 * A dirty git worktree still discards a proposal.
 */
export const PROPOSAL_CLI_DEFAULTS = {
  claude_local: {
    command: "claude",
    dangerouslySkipPermissions: false,
    extraArgs: ["--permission-mode", "plan"],
    helpVerified: true,
    runtimeExercised: false,
    note: "Verified from claude --help: --permission-mode exists, so plan stays the default. Runtime behavior has not been exercised.",
  },
  codex_local: {
    command: "codex",
    dangerouslyBypassApprovalsAndSandbox: false,
    extraArgs: ["-s", "read-only"],
    helpVerified: true,
    runtimeExercised: false,
    note: "Verified from codex help: exec -s/--sandbox accepts read-only. The Codex adapter already supplies exec. Runtime behavior has not been exercised.",
  },
  grok_build: {
    command: "grok",
    installedPath: "~/.grok/bin/grok",
    args: ["-p", ESCALATION_PROMPT_ARG, "--permission-mode", "plan"],
    passWakePromptOnStdin: false,
    helpVerified: true,
    runtimeExercised: false,
    note: "Verified from ~/.grok/bin/grok --help. Default is grok -p <prompt> --permission-mode plan. --permission-mode accepts default, acceptEdits, auto, dontAsk, bypassPermissions, and plan. --disallowed-tools and a flag to disable web search and fetch also exist and are not part of this default. -p/--single is single-turn and prints then exits. Runtime behavior has not been exercised. Do not send this traffic to the xAI API.",
  },
  kimi: {
    command: "kimi",
    installedPath: "~/.kimi-code/bin/kimi",
    alternateCommand: "kimi-cli",
    args: ["-p", ESCALATION_PROMPT_ARG, "--plan"],
    forbiddenArgs: ["-y", "--yolo"],
    passWakePromptOnStdin: false,
    helpVerified: true,
    runtimeExercised: false,
    note: "Verified from ~/.kimi-code/bin/kimi --help. Default is kimi -p <prompt> --plan. -p/--prompt is non-interactive. Never pass -y or --yolo. Runtime behavior has not been exercised.",
  },
} as const;

export const DEFAULT_CONFIG = {
  enabled: true,
  sink: "slack",
  harnessOrder: [...HARNESS_ORDER],
  fanoutCount: 2,
  judgeModel: DEFAULT_JUDGE_MODEL,
  slackChannelId: "",
  slackApproverUserId: "",
  proposalTimeoutSec: 600,
  autoApply: false,
  applyOnApprove: false,
  slackBotTokenSecretId: "",
  slackAppTokenSecretId: "",
  openRouterApiKeySecretId: "",
  harnessAgents: {
    claude_local: "",
    codex_local: "",
    grok_build: "",
    kimi: "",
  },
};
