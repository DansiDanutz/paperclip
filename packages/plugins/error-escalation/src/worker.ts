import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { parseEscalationConfig } from "./config.js";
import { handleRunEvent, handleSlackEnvelope, resolveDeps } from "./pipeline.js";
import { startSlackSocket } from "./slack.js";
import { listEscalationsForIssue } from "./state.js";

let stopSocket: (() => void) | null = null;
let hostCtx: PluginContext | null = null;

async function startSocket(ctx: PluginContext) {
  const config = parseEscalationConfig(await ctx.config.get());
  if (!config.slackAppTokenSecretId || !config.slackBotTokenSecretId) return;
  const appToken = await ctx.secrets.resolve(config.slackAppTokenSecretId);
  stopSocket?.();
  stopSocket = startSlackSocket({
    appToken,
    transport: { fetch: (url, init) => ctx.http.fetch(url, init) },
    onEnvelope: (envelope) => handleSlackEnvelope(ctx, envelope, resolveDeps(ctx)),
  }).stop;
}

const plugin = definePlugin({
  async setup(ctx) {
    hostCtx = ctx;
    const onRun = (event: Parameters<typeof handleRunEvent>[1]) => handleRunEvent(ctx, event, resolveDeps(ctx));
    ctx.events.on("agent.run.failed", onRun);
    ctx.events.on("agent.run.finished", onRun);
    ctx.events.on("agent.run.cancelled", onRun);

    ctx.data.register("escalation", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      if (!companyId || !issueId) return { escalations: [] };
      const escalations = await listEscalationsForIssue(ctx, companyId, issueId);
      return {
        escalations: escalations.map((record) => ({
          id: record.id,
          status: record.status,
          failedAdapterType: record.failedAdapterType,
          failedRunId: record.failedRunId,
          error: record.error,
          repoUrl: record.repoUrl,
          branchName: record.branchName,
          proposals: record.proposals.map((proposal) => ({
            adapterType: proposal.adapterType,
            status: proposal.status,
            text: proposal.text,
            discardReason: proposal.discardReason,
            error: proposal.error,
          })),
          judge: record.judge,
          decision: record.decision,
          failureNote: record.failureNote,
          slack: record.slack,
        })),
      };
    });

    await startSocket(ctx);
  },

  async onConfigChanged() {
    stopSocket?.();
    stopSocket = null;
    if (hostCtx) await startSocket(hostCtx);
  },

  async onShutdown() {
    stopSocket?.();
    stopSocket = null;
    hostCtx = null;
  },

  async onHealth() {
    return { status: "ok" as const, message: "Error escalation plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
