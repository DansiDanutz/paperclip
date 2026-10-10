# Error escalation

When a heartbeat fails, this plugin asks the next two harnesses for a read-only fix proposal, asks a free OpenRouter model to judge them, and posts that decision to one fleet Slack channel. Approving or rejecting only records the decision. Nothing is written to the repo.

The first harness is still the issue assignee. This plugin does not route work through Jev.

## Install

From a Paperclip checkout:

```sh
pnpm paperclipai plugin install ./packages/plugins/error-escalation
```

Enable the instance in the board plugin settings and fill the config below. Create the three company secrets first, then paste each secret's id into the matching config field. Do not put token values in plugin config.

## Secrets

| Secret name | Config field | What it is |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | `slackBotTokenSecretId` | Bot token (`xoxb-`) used to post, update, and open the reject modal |
| `SLACK_APP_TOKEN` | `slackAppTokenSecretId` | App-level token (`xapp-`) with `connections:write`, used for Socket Mode |
| `OPENROUTER_API_KEY` | `openRouterApiKeySecretId` | Key for `POST https://openrouter.ai/api/v1/chat/completions` |

## Slack app

Create a Slack app for the fleet channel and turn on **Socket Mode**. Paperclip is local, so there is no public Request URL.

Bot token scopes:

- `chat:write`
- `chat:write.public` so the bot can post in the public fleet channel
- `channels:history` for public-channel thread replies
- `groups:history` if the fleet channel is private

App settings:

- Socket Mode: on
- Interactivity: on (buttons and the reject modal). Leave the Request URL empty while Socket Mode is on
- Event subscriptions: subscribe to `message.channels` (and `message.groups` for a private channel) so a thread reply of `approve` or `reject` is delivered
- Invite the bot to the fleet channel

Dan approves with the **Approve** button (confirm dialog) or a thread reply that starts with `approve`. Reject opens a modal that requires a reason, or a thread reply that starts with `reject`. Only `slackApproverUserId` is accepted, and the event must be for the stored channel id and message timestamp. A second decision is ignored.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the pipeline off without uninstalling |
| `sink` | `slack` | Only Slack is implemented. Other values are ignored |
| `slackChannelId` | empty | One fleet-wide channel id, such as `C0123` |
| `slackApproverUserId` | empty | Slack user id allowed to approve or reject |
| `judgeModel` | `openrouter/free` | OpenRouter model id. `openrouter/free` routes only to currently free models. Change it to pin another model |
| `harnessOrder` | `claude_local`, `codex_local`, `grok_build`, `kimi` | Circular order used to pick the next harnesses |
| `fanoutCount` | `2` | How many of the next harnesses to ask |
| `proposalTimeoutSec` | `600` | Documented timeout budget for a proposal run |
| `harnessAgents.claude_local` | empty | Agent id for the Claude proposal harness |
| `harnessAgents.codex_local` | empty | Agent id for the Codex proposal harness |
| `harnessAgents.grok_build` | empty | Agent id for the Grok Build CLI proposal harness |
| `harnessAgents.kimi` | empty | Agent id for the Kimi proposal harness |
| `autoApply` | `false` | Ignored. There is no apply path |
| `applyOnApprove` | `false` | Ignored. Approve only records the decision |

`slackBotTokenSecretId`, `slackAppTokenSecretId`, and `openRouterApiKeySecretId` are the company secret ids from the table above.

## Proposal agents

These CLI flags are defaults to set on the four proposal agents. They were **not** executed on Dan's Mac from the environment that added this plugin. A dirty git worktree is discarded after the run, which is the backstop if a flag does not actually disable tools.

| Harness | Command Dan has installed | Suggested adapter settings |
| --- | --- | --- |
| Claude Code | `claude` | Claude local adapter. `dangerouslySkipPermissions: false`. `extraArgs`: `--permission-mode`, `plan` |
| Codex | `codex` | Codex local adapter. Leave bypass-approvals-and-sandbox off. `extraArgs`: `-s`, `read-only` |
| Grok Build | `~/.grok/bin/grok` | Process adapter. `command`: `~/.grok/bin/grok`. `passWakePromptOnStdin: true`. No confirmed no-tools flag. Do not send this traffic to the xAI API |
| Kimi | `~/.kimi-code/bin/kimi` (`kimi-cli` also exists) | Process adapter. `command`: `~/.kimi-code/bin/kimi`. `passWakePromptOnStdin: true`. No confirmed read-only flag |

`passWakePromptOnStdin` is off unless the process agent sets it, so existing process agents are unchanged. The plugin does not spawn `grok` or `kimi` itself.
