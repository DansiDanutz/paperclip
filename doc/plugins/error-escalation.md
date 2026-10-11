# Error escalation

When a heartbeat fails, this plugin asks the next two harnesses for a read-only fix proposal, asks a free OpenRouter model to judge them, and posts that decision to one fleet Slack channel. Approving or rejecting only records the decision. Nothing is written to the repo.

The first harness is still the issue assignee. This plugin does not route work through Jev.

## Install

From a Paperclip checkout:

```sh
npx paperclipai plugin install ./packages/plugins/error-escalation
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

Dan approves with the **Approve** button (confirm dialog) or a thread reply that starts with `approve`. Reject opens a modal that requires a reason, or a thread reply that starts with `reject`. `slackApproverUserId` is required. An empty value rejects every button, modal, and thread reply. The event must be for the stored channel id and message timestamp. A second decision is ignored. Concurrent approve and reject collapse to one saved decision.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the pipeline off without uninstalling |
| `sink` | `slack` | Only Slack is implemented. Other values are ignored |
| `slackChannelId` | empty | One fleet-wide channel id, such as `C0123` |
| `slackApproverUserId` | empty | Required Slack user id. Empty rejects every decision |
| `judgeModel` | `openrouter/free` | OpenRouter model id. `openrouter/free` routes only to currently free models. Change it to pin another model |
| `harnessOrder` | `claude_local`, `codex_local`, `grok_build`, `kimi` | Circular order used to pick the next harnesses |
| `fanoutCount` | `2` | How many of the next harnesses to ask |
| `proposalTimeoutSec` | `600` | Seconds before a still-pending proposal is marked failed. The plugin then removes its worktree. Paperclip has no plugin API to cancel the heartbeat, so a late result is ignored |
| `harnessAgents.claude_local` | empty | Agent id for the Claude proposal harness |
| `harnessAgents.codex_local` | empty | Agent id for the Codex proposal harness |
| `harnessAgents.grok_build` | empty | Agent id for the Grok Build CLI proposal harness |
| `harnessAgents.kimi` | empty | Agent id for the Kimi proposal harness |
| `companyIds` | empty | Company allow-list. When non-empty, only failures from these company ids escalate. Empty escalates every company that uses this config |
| `autoApply` | `false` | Ignored. There is no apply path |
| `applyOnApprove` | `false` | Ignored. Approve only records the decision |

On the Seme instance, set `companyIds` to `["8ac429da-9c3a-4b1c-804b-593af84bda97"]` so other companies on the same Paperclip process do not escalate.

A failure starts a new escalation only when it is `agent.run.failed`, its company is allowed, and it is not itself a proposal wake. A proposal wake is `escalationProposal: true` or `wakeReason` equal to `error_escalation_proposal`. Those events are ingested as proposal results. Ordinary wake reasons such as `issue_assigned` still escalate. The failed assignee stays in `harnessAgents` and is not skipped by agent id: that id is how the plugin knows which harness failed. Proposal runs are distinguished only by the proposal wake reason.

`slackBotTokenSecretId`, `slackAppTokenSecretId`, and `openRouterApiKeySecretId` are the company secret ids from the table above.

## Proposal agents

These CLI flags were checked against `--help` on Dan's Mac. Their runtime behavior has not been exercised.

Each proposal runs in its own detached `git worktree`, not in the issue checkout. The worktree starts from `HEAD` plus the source checkout's staged, unstaged, and untracked files. That copy does not change the source checkout. The mutation baseline is a content hash of that copy, taken after the copy, plus HEAD and porcelain. A proposal that leaves those bytes alone is kept. Rewriting a file that was already dirty or untracked, or making a commit, discards it. The judge receives the adapter's extracted final answer. Diagnostic stdout and stderr excerpts stay separate and are not used as the proposal when that answer is present. The wake does not take the issue execution lock. Claude and Codex use the worktree even when the agent has its own `cwd`. If the reported execution directory is not that worktree, the proposal is discarded. If the worktree cannot be created, that slot fails and the real checkout is not used.

A fan-out is recoverable from the moment it is saved, including a restart during the first worktree or invoke. Startup and a redelivered failure start any harness slot that was never recorded. Overlapping recovery claims that escalation before it waits, reloads the missing slots, and starts each harness once. Slots that are already pending are left to finish or time out. Cleanup errors are logged and do not skip the remaining harnesses or the judge. Slack approve and reject run outside the config call that opened the socket, with the escalation's company id on each secret and state request. Two escalations for the same issue are both listed.

Approve and Reject buttons are included when a judge result exists, including the first Slack post and a retry. A failure with nothing to judge has no buttons.

Grok and Kimi report the adapter type `process`. The failed harness is the `harnessAgents` entry whose agent id matches the failed run, and the next two harnesses are chosen from that name.

A judge or Slack failure is retried three times. The escalation shows `failed` with `failureNote` while it retries, and stays `failed` after the last attempt. `awaiting_approval` is stored only after Slack returns a message timestamp.

Socket Mode uses the `ws` package so it connects on Node 20. A failed `apps.connections.open` is retried, and health is degraded until Slack sends its `hello` message. Slack disconnect messages and socket errors close the old connection and schedule a new connection. Retry delay grows after failed handshakes and resets after `hello`. Events from a replaced socket are ignored.

| Harness | Command | Adapter settings |
| --- | --- | --- |
| Claude Code | `claude` | Claude local adapter. `dangerouslySkipPermissions: false`. `extraArgs`: `--permission-mode`, `plan`. `--permission-mode` exists, so `plan` stays. |
| Codex | `codex exec` | Codex local adapter. The adapter already adds `exec`. Leave bypass-approvals-and-sandbox off. `extraArgs`: `-s`, `read-only`. `exec -s`/`--sandbox` accepts `read-only`. |
| Grok Build | `~/.grok/bin/grok -p <prompt> --permission-mode plan` | Process adapter. `command`: `~/.grok/bin/grok`. `args`: `-p`, `{escalationPrompt}`, `--permission-mode`, `plan`. Leave `passWakePromptOnStdin` off. `--permission-mode` accepts `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, and `plan`. `-p`/`--single` is single-turn and prints then exits. `--disallowed-tools` and a flag to disable web search and fetch exist; they are not part of this default. Do not send this traffic to the xAI API. |
| Kimi | `~/.kimi-code/bin/kimi -p <prompt> --plan` | Process adapter. `command`: `~/.kimi-code/bin/kimi` (`kimi-cli` also exists). `args`: `-p`, `{escalationPrompt}`, `--plan`. Leave `passWakePromptOnStdin` off. `-p`/`--prompt` is non-interactive. Never pass `-y` or `--yolo`. |

`{escalationPrompt}` is replaced with the proposal text when the process adapter runs. `passWakePromptOnStdin` stays off unless a process agent sets it, so existing process agents are unchanged. The plugin does not spawn `grok` or `kimi` itself.
