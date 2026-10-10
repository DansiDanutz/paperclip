import { describe, expect, it } from "vitest";
import { applyEscalationPromptArg, execute } from "../adapters/process/execute.ts";

const reader = [
  "let data = '';",
  "process.stdin.on('data', (chunk) => { data += chunk; });",
  "process.stdin.on('end', () => { process.stdout.write(data); });",
].join("");

async function run(config: Record<string, unknown>, context: Record<string, unknown>) {
  const logs: string[] = [];
  return execute({
    runId: `stdin-${Date.now()}-${Math.random()}`,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "proposal",
      adapterType: "process",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: process.execPath,
      args: ["-e", reader],
      timeoutSec: 10,
      ...config,
    },
    context,
    onLog: async (stream, chunk) => {
      logs.push(`${stream}:${chunk}`);
    },
  });
}

describe("process adapter escalation prompt", () => {
  it("substitutes {escalationPrompt} and drops an empty -p", () => {
    expect(applyEscalationPromptArg(
      ["-p", "{escalationPrompt}", "--permission-mode", "plan"],
      "proposal only",
    )).toEqual(["-p", "proposal only", "--permission-mode", "plan"]);
    expect(applyEscalationPromptArg(
      ["-p", "{escalationPrompt}", "--plan"],
      "",
    )).toEqual(["--plan"]);
    expect(applyEscalationPromptArg(["--plan", "-y"], "unused")).toEqual(["--plan", "-y"]);
  });

  it("passes the prompt as the -p argument", async () => {
    const result = await execute({
      runId: `arg-${Date.now()}`,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "proposal",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.argv.slice(1).join('\\n'))", "--", "-p", "{escalationPrompt}", "--plan"],
        timeoutSec: 10,
      },
      context: { escalationPrompt: "kimi proposal" },
      onLog: async () => undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(String((result.resultJson as { stdout?: string }).stdout ?? "")).toBe("-p\nkimi proposal\n--plan");
  });

  it("writes the escalation prompt only when passWakePromptOnStdin is set", async () => {
    const skipped = await run({}, { escalationPrompt: "proposal-only do not edit" });
    expect(skipped.exitCode).toBe(0);
    expect(String((skipped.resultJson as { stdout?: string }).stdout ?? "")).toBe("");

    const passed = await run(
      { passWakePromptOnStdin: true },
      { escalationPrompt: "proposal-only do not edit" },
    );
    expect(passed.exitCode).toBe(0);
    expect(String((passed.resultJson as { stdout?: string }).stdout ?? "")).toContain("proposal-only do not edit");
  });
});
