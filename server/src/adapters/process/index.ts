import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments. The exact argument \`{escalationPrompt}\` is replaced with the heartbeat escalation prompt. A preceding \`-p\`, \`--single\`, or \`--prompt\` is dropped with it when that prompt is empty.
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables
- passWakePromptOnStdin (boolean, optional): write the heartbeat escalation prompt to stdin. Leave unset for existing process agents. Grok and Kimi proposal agents pass the prompt with \`-p\` instead.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`,
};
