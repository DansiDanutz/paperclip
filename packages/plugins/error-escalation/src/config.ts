import { DEFAULT_CONFIG, HARNESS_ORDER, type HarnessId } from "./constants.js";

export interface EscalationConfig {
  enabled: boolean;
  sink: "slack";
  harnessOrder: string[];
  fanoutCount: number;
  judgeModel: string;
  slackChannelId: string;
  slackApproverUserId: string;
  proposalTimeoutSec: number;
  autoApply: false;
  applyOnApprove: false;
  slackBotTokenSecretId: string;
  slackAppTokenSecretId: string;
  openRouterApiKeySecretId: string;
  /**
   * When non-empty, only failures from these companies escalate.
   * An empty list escalates every company that delivers this config.
   */
  companyIds: string[];
  harnessAgents: Record<HarnessId, string>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asCompanyIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(ids)];
}

/** Empty `companyIds` allows every company. A non-empty list is an allow-list. */
export function companyAllowed(config: EscalationConfig, companyId: string): boolean {
  if (config.companyIds.length === 0) return true;
  return config.companyIds.includes(companyId);
}

export function parseEscalationConfig(raw: Record<string, unknown> | null | undefined): EscalationConfig {
  const source = raw ?? {};
  const order = Array.isArray(source.harnessOrder)
    ? source.harnessOrder.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : DEFAULT_CONFIG.harnessOrder;
  const agentsRaw = source.harnessAgents && typeof source.harnessAgents === "object"
    ? (source.harnessAgents as Record<string, unknown>)
    : {};
  const harnessAgents = {} as Record<HarnessId, string>;
  for (const harness of HARNESS_ORDER) {
    harnessAgents[harness] = asString(agentsRaw[harness]);
  }
  const fanout = typeof source.fanoutCount === "number" && Number.isFinite(source.fanoutCount)
    ? Math.max(0, Math.floor(source.fanoutCount))
    : DEFAULT_CONFIG.fanoutCount;
  return {
    enabled: asBoolean(source.enabled, DEFAULT_CONFIG.enabled),
    sink: "slack",
    harnessOrder: order.length > 0 ? order : [...DEFAULT_CONFIG.harnessOrder],
    fanoutCount: fanout,
    judgeModel: asString(source.judgeModel, DEFAULT_CONFIG.judgeModel) || DEFAULT_CONFIG.judgeModel,
    slackChannelId: asString(source.slackChannelId),
    slackApproverUserId: asString(source.slackApproverUserId),
    proposalTimeoutSec: typeof source.proposalTimeoutSec === "number" ? source.proposalTimeoutSec : DEFAULT_CONFIG.proposalTimeoutSec,
    autoApply: false,
    applyOnApprove: false,
    slackBotTokenSecretId: asString(source.slackBotTokenSecretId),
    slackAppTokenSecretId: asString(source.slackAppTokenSecretId),
    openRouterApiKeySecretId: asString(source.openRouterApiKeySecretId),
    companyIds: asCompanyIds(source.companyIds),
    harnessAgents,
  };
}
