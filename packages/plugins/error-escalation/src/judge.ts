import type { ProposalSlot } from "./state.js";

export interface JudgeResult {
  decision: string;
  reason: string;
}

export function buildJudgeRequest(input: {
  model: string;
  error: string | null;
  proposals: ProposalSlot[];
}) {
  const usable = input.proposals.filter((proposal) => proposal.status === "ready" && proposal.text);
  const body = {
    model: input.model,
    messages: [
      {
        role: "system",
        content: "You compare read-only fix proposals. Pick or merge one. Reply with JSON only: {\"decision\":\"...\",\"reason\":\"...\"}. Do not include tools, commands, or a request to apply the change.",
      },
      {
        role: "user",
        content: [
          `Error: ${input.error ?? "unknown"}`,
          ...usable.map((proposal, index) => `Proposal ${index + 1} (${proposal.adapterType}):\n${proposal.text}`),
        ].join("\n\n"),
      },
    ],
  };
  return body;
}

export function parseJudgeContent(content: string): JudgeResult {
  const trimmed = content.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  const candidate = jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;
  const parsed = JSON.parse(candidate) as { decision?: unknown; reason?: unknown };
  const decision = typeof parsed.decision === "string" ? parsed.decision.trim() : "";
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (!decision || !reason) {
    throw new Error("Judge response did not include decision and reason");
  }
  return { decision, reason };
}

export async function requestJudge(input: {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  apiKey: string;
  model: string;
  error: string | null;
  proposals: ProposalSlot[];
}): Promise<JudgeResult> {
  const response = await input.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildJudgeRequest(input)),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter judge failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter judge returned empty content");
  }
  return parseJudgeContent(content);
}
