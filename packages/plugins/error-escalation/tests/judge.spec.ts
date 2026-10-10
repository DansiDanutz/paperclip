import { describe, expect, it, vi } from "vitest";
import { buildJudgeRequest, parseJudgeContent, requestJudge } from "../src/judge.js";
import type { ProposalSlot } from "../src/state.js";

function proposal(adapterType: string, text: string): ProposalSlot {
  return {
    adapterType,
    agentId: "agent",
    runId: "run",
    text,
    dirty: false,
    discarded: false,
    discardReason: null,
    status: "ready",
    error: null,
  };
}

describe("judge", () => {
  it("parses a JSON decision and sends no tools", async () => {
    const body = buildJudgeRequest({
      model: "openrouter/free",
      error: "exit 1",
      proposals: [proposal("codex_local", "diff --git a"), proposal("grok_build", "diff --git b")],
    });
    expect(body.model).toBe("openrouter/free");
    expect(body).not.toHaveProperty("tools");
    expect(JSON.stringify(body)).not.toContain("xai");

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body));
      expect(parsed.tools).toBeUndefined();
      expect(parsed.model).toBe("openrouter/free");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{\"decision\":\"Use Codex\",\"reason\":\"Smaller diff\"}" } }],
      }), { status: 200 });
    });

    const result = await requestJudge({
      fetchImpl: fetchImpl as typeof fetch,
      apiKey: "test-key",
      model: "openrouter/free",
      error: "exit 1",
      proposals: [proposal("codex_local", "diff --git a")],
    });
    expect(result).toEqual({ decision: "Use Codex", reason: "Smaller diff" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty judge payload", () => {
    expect(() => parseJudgeContent("{\"decision\":\"\"}")).toThrow(/decision and reason/);
  });
});
