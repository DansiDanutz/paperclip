import { describe, expect, it } from "vitest";
import { selectNextHarnesses } from "../src/harnesses.js";

describe("selectNextHarnesses", () => {
  const order = ["claude_local", "codex_local", "grok_build", "kimi"];

  it("takes the next two after the failed harness", () => {
    expect(selectNextHarnesses("claude_local", order, 2)).toEqual(["codex_local", "grok_build"]);
    expect(selectNextHarnesses("codex_local", order, 2)).toEqual(["grok_build", "kimi"]);
    expect(selectNextHarnesses("grok_build", order, 2)).toEqual(["kimi", "claude_local"]);
    expect(selectNextHarnesses("kimi", order, 2)).toEqual(["claude_local", "codex_local"]);
  });

  it("starts at the beginning when the failed adapter is outside the order", () => {
    expect(selectNextHarnesses("cursor", order, 2)).toEqual(["claude_local", "codex_local"]);
  });
});
