import WebSocket from "ws";
import { SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION, SLACK_REJECT_CALLBACK } from "./constants.js";
import type { EscalationRecord } from "./state.js";

export interface SlackMessageRef {
  channel: string;
  ts: string;
}

export type SlackIntent =
  | {
      type: "approve" | "reject";
      escalationId: string;
      userId: string;
      channelId: string;
      messageTs: string;
      reason: string | null;
    }
  | {
      type: "open_reject_modal";
      escalationId: string;
      userId: string;
      channelId: string;
      messageTs: string;
      triggerId: string;
    }
  | {
      type: "thread_reply";
      userId: string;
      channelId: string;
      threadTs: string;
      outcome: "approved" | "rejected";
      reason: string | null;
    }
  | { type: "ignore" };

export interface SlackTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function buildApprovalMessage(record: EscalationRecord, includeActions: boolean) {
  const decision = record.judge;
  const summary = decision
    ? `*Decision:* ${decision.decision}\n*Reason:* ${decision.reason}`
    : record.failureNote ?? "No usable proposal.";
  const text = [
    `Error escalation ${record.id}`,
    `Failed adapter: ${record.failedAdapterType}`,
    summary,
    "Nothing will be written. Auto-apply is off.",
  ].join("\n");
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Error escalation* \`${record.id}\``,
          `Issue: ${record.issueId ?? "none"}`,
          `Failed adapter: \`${record.failedAdapterType}\``,
          `Run: \`${record.failedRunId}\``,
          `Repo: ${record.repoUrl ?? "unknown"} @ ${record.branchName ?? record.repoRef ?? "unknown"}`,
          `Error: ${record.error ?? "unknown"}`,
        ].join("\n"),
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: summary },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Nothing will be written. Auto-apply is off. Approve only records Dan's decision." }],
    },
  ];
  if (includeActions) {
    blocks.push({
      type: "actions",
      block_id: "error_escalation_actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_APPROVE_ACTION,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: record.id,
          confirm: {
            title: { type: "plain_text", text: "Record approval?" },
            text: { type: "mrkdwn", text: "This records your approval. It will not change the repo." },
            confirm: { type: "plain_text", text: "Approve" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
        {
          type: "button",
          action_id: SLACK_REJECT_ACTION,
          style: "danger",
          text: { type: "plain_text", text: "Reject" },
          value: record.id,
        },
      ],
    });
  }
  return { text, blocks };
}

export function parseThreadReply(body: string): { outcome: "approved" | "rejected"; reason: string | null } | null {
  const match = body.trim().match(/^(approve|reject)\b[:\s-]*(.*)$/i);
  if (!match) return null;
  const outcome = match[1]!.toLowerCase() === "approve" ? "approved" : "rejected";
  const reason = match[2]?.trim() ? match[2].trim() : null;
  return { outcome, reason };
}

function metadata(escalationId: string, channelId: string, messageTs: string) {
  return JSON.stringify({ escalationId, channelId, messageTs });
}

function readMetadata(value: unknown): { escalationId: string; channelId: string; messageTs: string } | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const escalationId = text(parsed.escalationId);
    const channelId = text(parsed.channelId);
    const messageTs = text(parsed.messageTs);
    if (!escalationId || !channelId || !messageTs) return null;
    return { escalationId, channelId, messageTs };
  } catch {
    return null;
  }
}

export function parseSlackEnvelope(envelope: unknown): SlackIntent {
  const root = asRecord(envelope);
  if (!root) return { type: "ignore" };
  const payload = asRecord(root.payload) ?? root;
  const payloadType = text(payload.type);

  if (payloadType === "block_actions") {
    const userId = text(asRecord(payload.user)?.id);
    const channelId = text(asRecord(payload.channel)?.id);
    const messageTs = text(asRecord(payload.message)?.ts);
    const action = Array.isArray(payload.actions) ? asRecord(payload.actions[0]) : null;
    const actionId = text(action?.action_id);
    const escalationId = text(action?.value);
    if (!userId || !channelId || !messageTs || !escalationId) return { type: "ignore" };
    if (actionId === SLACK_APPROVE_ACTION) {
      return { type: "approve", escalationId, userId, channelId, messageTs, reason: null };
    }
    if (actionId === SLACK_REJECT_ACTION) {
      const triggerId = text(payload.trigger_id);
      if (!triggerId) return { type: "ignore" };
      return { type: "open_reject_modal", escalationId, userId, channelId, messageTs, triggerId };
    }
  }

  if (payloadType === "view_submission") {
    const userId = text(asRecord(payload.user)?.id);
    const view = asRecord(payload.view);
    if (!userId || text(view?.callback_id) !== SLACK_REJECT_CALLBACK) return { type: "ignore" };
    const stored = readMetadata(view?.private_metadata);
    if (!stored) return { type: "ignore" };
    const state = asRecord(view?.state);
    const values = asRecord(state?.values);
    const block = asRecord(values?.reason_block);
    const field = asRecord(block?.reason);
    const reason = text(field?.value);
    if (!reason) return { type: "ignore" };
    return {
      type: "reject",
      escalationId: stored.escalationId,
      userId,
      channelId: stored.channelId,
      messageTs: stored.messageTs,
      reason,
    };
  }

  const event = asRecord(payload.event) ?? (payloadType === "message" ? payload : null);
  if (text(event?.type) === "message" && !text(event?.bot_id) && !text(event?.subtype)) {
    const userId = text(event?.user);
    const channelId = text(event?.channel);
    const threadTs = text(event?.thread_ts);
    const body = text(event?.text);
    if (!userId || !channelId || !threadTs || !body) return { type: "ignore" };
    const reply = parseThreadReply(body);
    if (!reply) return { type: "ignore" };
    return {
      type: "thread_reply",
      userId,
      channelId,
      threadTs,
      outcome: reply.outcome,
      reason: reply.reason,
    };
  }

  return { type: "ignore" };
}

export function rejectModalView(escalationId: string, channelId: string, messageTs: string) {
  return {
    type: "modal",
    callback_id: SLACK_REJECT_CALLBACK,
    private_metadata: metadata(escalationId, channelId, messageTs),
    title: { type: "plain_text", text: "Reject fix" },
    submit: { type: "plain_text", text: "Reject" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "reason_block",
        label: { type: "plain_text", text: "Reason" },
        element: {
          type: "plain_text_input",
          action_id: "reason",
          multiline: true,
        },
      },
    ],
  };
}

async function slackApi(
  transport: SlackTransport,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await transport.fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    const error = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    throw new Error(`Slack ${method} failed: ${error}`);
  }
  return payload;
}

export async function postEscalationMessage(input: {
  transport: SlackTransport;
  token: string;
  channel: string;
  record: EscalationRecord;
}): Promise<SlackMessageRef> {
  const message = buildApprovalMessage(input.record, input.record.status === "awaiting_approval");
  const payload = await slackApi(input.transport, input.token, "chat.postMessage", {
    channel: input.channel,
    text: message.text,
    blocks: message.blocks,
  });
  const channel = text(payload.channel) ?? input.channel;
  const ts = text(payload.ts);
  if (!ts) throw new Error("Slack chat.postMessage did not return ts");
  return { channel, ts };
}

export async function updateEscalationMessage(input: {
  transport: SlackTransport;
  token: string;
  record: EscalationRecord;
}): Promise<void> {
  if (!input.record.slack) return;
  const note = input.record.decision
    ? `${input.record.decision.outcome} by ${input.record.decision.actorId}${input.record.decision.reason ? `: ${input.record.decision.reason}` : ""}`
    : input.record.failureNote ?? input.record.status;
  const message = buildApprovalMessage(
    { ...input.record, failureNote: note, judge: input.record.judge },
    false,
  );
  message.blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Status:* ${note}` },
  });
  await slackApi(input.transport, input.token, "chat.update", {
    channel: input.record.slack.channel,
    ts: input.record.slack.ts,
    text: message.text,
    blocks: message.blocks,
  });
}

export async function postEphemeral(input: {
  transport: SlackTransport;
  token: string;
  channel: string;
  user: string;
  text: string;
}): Promise<void> {
  await slackApi(input.transport, input.token, "chat.postEphemeral", {
    channel: input.channel,
    user: input.user,
    text: input.text,
  });
}

export async function openRejectModal(input: {
  transport: SlackTransport;
  token: string;
  triggerId: string;
  escalationId: string;
  channelId: string;
  messageTs: string;
}): Promise<void> {
  await slackApi(input.transport, input.token, "views.open", {
    trigger_id: input.triggerId,
    view: rejectModalView(input.escalationId, input.channelId, input.messageTs),
  });
}

export function envelopeId(envelope: unknown): string | null {
  return text(asRecord(envelope)?.envelope_id);
}

export type SocketConnectionState = "off" | "connecting" | "open" | "disconnected";

export function socketHealth(state: SocketConnectionState): { status: "ok" | "degraded"; message: string } {
  if (state === "open") return { status: "ok", message: "Slack socket connected" };
  if (state === "off") return { status: "ok", message: "Error escalation plugin ready" };
  return { status: "degraded", message: "Slack socket is disconnected" };
}

export interface SlackSocketLike {
  send(data: string): void;
  close(): void;
  on(event: "message" | "close" | "error", cb: (data?: unknown) => void): void;
}

function rawText(data: unknown): string {
  if (typeof data === "string") return data;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return "";
}

function defaultSocket(url: string): SlackSocketLike {
  const socket = new WebSocket(url);
  return {
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
    },
    on(event, cb) {
      if (event === "message") socket.on("message", (data) => cb(data));
      else if (event === "close") socket.on("close", () => cb(undefined));
      else socket.on("error", (error) => cb(error));
    },
  };
}

/**
 * Slack Socket Mode client. Node 20 has no global WebSocket, so this uses `ws`.
 * A failed `apps.connections.open` is retried. Tests can inject the socket.
 */
export function startSlackSocket(input: {
  appToken: string;
  transport: SlackTransport;
  onEnvelope: (envelope: unknown) => Promise<void>;
  WebSocketImpl?: new (url: string) => SlackSocketLike;
  schedule?: (ms: number, fn: () => void) => () => void;
  onState?: (state: SocketConnectionState, detail?: string) => void;
}): { stop: () => void } {
  let stopped = false;
  let socket: SlackSocketLike | null = null;
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;
  const schedule = input.schedule ?? ((ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  });

  const retry = (detail: string) => {
    if (stopped) return;
    input.onState?.("disconnected", detail);
    attempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    cancelRetry?.();
    cancelRetry = schedule(delay, () => {
      cancelRetry = null;
      void connect();
    });
  };

  const connect = async () => {
    if (stopped) return;
    input.onState?.("connecting");
    try {
      const opened = await slackApi(input.transport, input.appToken, "apps.connections.open", {});
      const url = text(opened.url);
      if (!url) throw new Error("Slack apps.connections.open did not return a url");
      if (stopped) return;
      const openedSocket = input.WebSocketImpl ? new input.WebSocketImpl(url) : defaultSocket(url);
      socket = openedSocket;
      attempt = 0;
      input.onState?.("open");
      openedSocket.on("message", (data) => {
        void (async () => {
          const raw = rawText(data);
          let envelope: unknown;
          try {
            envelope = JSON.parse(raw);
          } catch {
            return;
          }
          const id = envelopeId(envelope);
          if (id) openedSocket.send(JSON.stringify({ envelope_id: id }));
          const type = text(asRecord(envelope)?.type);
          if (type === "hello" || type === "disconnect") return;
          await input.onEnvelope(envelope);
        })().catch(() => undefined);
      });
      openedSocket.on("close", () => {
        if (socket === openedSocket) socket = null;
        if (!stopped) retry("socket closed");
      });
      openedSocket.on("error", (error) => {
        input.onState?.("disconnected", error instanceof Error ? error.message : "socket error");
      });
    } catch (error) {
      if (stopped) return;
      retry(error instanceof Error ? error.message : "apps.connections.open failed");
    }
  };

  void connect();
  return {
    stop() {
      stopped = true;
      cancelRetry?.();
      cancelRetry = null;
      socket?.close();
      socket = null;
    },
  };
}
