import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, DEFAULT_JUDGE_MODEL, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Error escalation",
  description: "On a failed heartbeat, ask two other harnesses for read-only fix proposals, have a free OpenRouter model judge them, and send the decision to Slack for approval.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issue.comments.create",
    "issue.documents.write",
    "agents.read",
    "agents.invoke",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", title: "Enabled", default: DEFAULT_CONFIG.enabled },
      sink: { type: "string", title: "Sink", default: "slack", description: "Only slack is implemented. The sink interface can grow later." },
      harnessOrder: {
        type: "array",
        title: "Harness order",
        items: { type: "string" },
        default: DEFAULT_CONFIG.harnessOrder,
      },
      fanoutCount: { type: "number", title: "Fan-out count", default: DEFAULT_CONFIG.fanoutCount },
      judgeModel: { type: "string", title: "OpenRouter judge model", default: DEFAULT_JUDGE_MODEL },
      slackChannelId: { type: "string", title: "Fleet Slack channel ID", default: "" },
      slackApproverUserId: { type: "string", title: "Approver Slack user ID", default: "" },
      proposalTimeoutSec: { type: "number", title: "Proposal timeout seconds", default: DEFAULT_CONFIG.proposalTimeoutSec },
      autoApply: { type: "boolean", title: "Auto-apply", default: false, description: "Ignored. Approve only records the decision." },
      applyOnApprove: { type: "boolean", title: "Apply on approve", default: false, description: "Ignored. There is no apply path." },
      slackBotTokenSecretId: { type: "string", title: "SLACK_BOT_TOKEN secret id", default: "" },
      slackAppTokenSecretId: { type: "string", title: "SLACK_APP_TOKEN secret id", default: "" },
      openRouterApiKeySecretId: { type: "string", title: "OPENROUTER_API_KEY secret id", default: "" },
      companyIds: {
        type: "array",
        title: "Company allow-list",
        items: { type: "string" },
        default: [],
        description: "When non-empty, only failures from these company ids escalate. Leave empty to escalate every company that uses this config.",
      },
      harnessAgents: {
        type: "object",
        title: "Proposal agent ids",
        properties: {
          claude_local: { type: "string", default: "" },
          codex_local: { type: "string", default: "" },
          grok_build: { type: "string", default: "" },
          kimi: { type: "string", default: "" },
        },
      },
    },
  },
  ui: {
    slots: [
      {
        type: "detailTab",
        id: "error-escalation",
        displayName: "Escalation",
        exportName: "ErrorEscalationIssueTab",
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
