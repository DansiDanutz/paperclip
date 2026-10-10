import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  runtimeToolDelivery: "environment",
  execute,
  testEnvironment,
  models: [],
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory. \`escalationCwd\` on the wake overrides this
- args may contain \`{escalationPrompt}\`, replaced with the wake's escalation prompt. An empty prompt drops that token and a preceding \`-p\`, \`--single\`, or \`--prompt\`
- passWakePromptOnStdin (boolean, optional): when true, write \`escalationPrompt\` to the child stdin. Off by default
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`,
};
