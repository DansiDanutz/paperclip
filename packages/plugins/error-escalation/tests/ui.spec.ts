import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorEscalationIssueTab } from "../src/ui/index.js";

function renderWithData(data: unknown, loading = false, error: Error | null = null) {
  (globalThis as { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginData: () => ({ data, loading, error, refresh: () => undefined }),
    },
  };
  return renderToStaticMarkup(createElement(ErrorEscalationIssueTab, {
    context: {
      companyId: "company-1",
      entityId: "issue-1",
      entityType: "issue",
      pluginId: "paperclip.error-escalation",
    },
  }));
}

describe("error escalation issue tab", () => {
  it("renders the decision as read-only text", () => {
    const html = renderWithData({
      escalations: [{
        id: "esc-1",
        status: "approved",
        failedAdapterType: "claude_local",
        failedRunId: "run-1",
        error: "boom",
        repoUrl: "https://github.com/DansiDanutz/paperclip",
        branchName: "master",
        proposals: [{ adapterType: "codex_local", status: "ready", text: "diff", discardReason: null, error: null }],
        judge: { model: "openrouter/free", decision: "Use Codex", reason: "Smaller" },
        decision: { outcome: "approved", actorId: "U_DAN", reason: null, at: "2026-10-09T00:00:00.000Z" },
        failureNote: null,
        slack: { channel: "C-FLEET", ts: "1.2" },
      }],
    });
    expect(html).toContain("Use Codex");
    expect(html).toContain("Nothing is written to the repo");
    expect(html).not.toContain("<button");
  });

  it("shows empty, loading, and error states", () => {
    expect(renderWithData({ escalations: [] })).toContain("No error escalations");
    expect(renderWithData(null, true)).toContain("Loading escalation");
    expect(renderWithData(null, false, new Error("nope"))).toContain("Could not load escalation");
  });
});
