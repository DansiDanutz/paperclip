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

/**
 * CLI flags Dan can set on the proposal agents.
 * They were not verified against the binaries on Dan's Mac from this environment.
 * A dirty git worktree still discards a proposal.
 */
export const UNVERIFIED_CLI_DEFAULTS = {
  claude_local: {
    command: "claude",
    dangerouslySkipPermissions: false,
    extraArgs: ["--permission-mode", "plan"],
    note: "Unverified: Claude Code plan mode was not executed on Dan's Mac from this environment.",
  },
  codex_local: {
    command: "codex",
    dangerouslyBypassApprovalsAndSandbox: false,
    extraArgs: ["-s", "read-only"],
    note: "Unverified: Codex read-only sandbox was not executed on Dan's Mac from this environment.",
  },
  grok_build: {
    command: "grok",
    installedPath: "~/.grok/bin/grok",
    extraArgs: [] as string[],
    passWakePromptOnStdin: true,
    note: "Unverified: the grok binary at ~/.grok/bin/grok has no confirmed no-tools flag. Do not send this traffic to the xAI API.",
  },
  kimi: {
    command: "kimi",
    installedPath: "~/.kimi-code/bin/kimi",
    alternateCommand: "kimi-cli",
    extraArgs: [] as string[],
    passWakePromptOnStdin: true,
    note: "Unverified: ~/.kimi-code/bin/kimi (kimi-cli also exists) has no confirmed read-only flag.",
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
