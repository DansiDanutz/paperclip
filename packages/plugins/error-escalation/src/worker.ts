import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { companyAllowed, parseEscalationConfig, type EscalationConfig } from "./config.js";
import { handleRunEvent, handleSlackEnvelope, resolveDeps, resumeEscalations, setActiveEscalationConfig } from "./pipeline.js";
import { socketHealth, startSlackSocket, type SocketConnectionState } from "./slack.js";
import { listEscalationsForIssue } from "./state.js";

let stopSocket: (() => void) | null = null;
let hostCtx: PluginContext | null = null;
let socketState: SocketConnectionState = "off";

async function startSocket(ctx: PluginContext, config: EscalationConfig, companyId: string | null) {
  if (!config.slackAppTokenSecretId || !config.slackBotTokenSecretId) {
    socketState = "off";
    return;
  }
  const appToken = await ctx.secrets.resolve(
    config.slackAppTokenSecretId,
    companyId ? { companyId } : undefined,
  );
  stopSocket?.();
  socketState = "connecting";
  // The socket outlives configChanged. Starting it inside that invocation would
  // stamp every later approve/reject with an id the host has already dropped.
  stopSocket = ctx.runOutsideInvocation(() => startSlackSocket({
    appToken,
    transport: { fetch: (url, init) => ctx.http.fetch(url, init) },
    onEnvelope: (envelope) => handleSlackEnvelope(ctx, envelope, resolveDeps(ctx)),
    onState: (state) => {
      socketState = state;
    },
  })).stop;
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
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue || issue.companyId !== companyId) return { escalations: [] };
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
    // setup() has no company scope. Socket Mode and resume run from onConfigChanged.
  },

  async onConfigChanged(newConfig, context) {
    const config = parseEscalationConfig(newConfig);
    const companyId = context?.companyId ?? null;
    setActiveEscalationConfig(config, companyId);
    stopSocket?.();
    stopSocket = null;
    socketState = "off";
    if (!hostCtx) return;
    await startSocket(hostCtx, config, companyId);
    if (companyId && companyAllowed(config, companyId)) {
      await resumeEscalations(hostCtx, resolveDeps(hostCtx), companyId);
    }
  },

  async onShutdown() {
    stopSocket?.();
    stopSocket = null;
    socketState = "off";
    hostCtx = null;
    setActiveEscalationConfig(null);
  },

  async onHealth() {
    const health = socketHealth(socketState);
    return { status: health.status, message: health.message };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
