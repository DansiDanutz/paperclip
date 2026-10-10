import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  asString,
  asBoolean,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "../utils.js";

const ESCALATION_PROMPT_ARG = "{escalationPrompt}";
const PROMPT_FLAGS = new Set(["-p", "--single", "--prompt"]);

export function applyEscalationPromptArg(args: string[], prompt: string): string[] {
  const resolved: string[] = [];
  for (const arg of args) {
    if (arg !== ESCALATION_PROMPT_ARG) {
      resolved.push(arg);
      continue;
    }
    if (!prompt) {
      const previous = resolved[resolved.length - 1];
      if (previous && PROMPT_FLAGS.has(previous)) resolved.pop();
      continue;
    }
    resolved.push(prompt);
  }
  return resolved;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const escalationCwd = asString(context.escalationCwd, "").trim();
  const cwd = escalationCwd || asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  const passWakePromptOnStdin = asBoolean(config.passWakePromptOnStdin, false);
  const escalationPrompt = asString(context.escalationPrompt, "").trim();
  const commandArgs = applyEscalationPromptArg(args, escalationPrompt);
  const stdin = passWakePromptOnStdin && escalationPrompt ? escalationPrompt : undefined;

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command: resolvedCommand,
      cwd,
      commandArgs,
      env: loggedEnv,
    });
  }

  const proc = await runChildProcess(runId, command, commandArgs, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    stdin,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
