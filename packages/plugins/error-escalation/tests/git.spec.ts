import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { proposalDirtiedWorktree, readPorcelain } from "../src/git.js";

function gitRepo(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "escalation-git-"));
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["commit", "-m", "init"], { cwd });
  return cwd;
}

describe("dirty worktree backstop", () => {
  it("keeps a clean tree and discards a tree a proposal writes", async () => {
    const cwd = gitRepo();
    const baseline = await readPorcelain(cwd);
    expect(baseline.ok).toBe(true);
    expect(proposalDirtiedWorktree({
      cwd,
      baselineCwd: cwd,
      baselinePorcelain: baseline.ok ? baseline.porcelain : null,
      current: baseline.ok ? baseline : null,
    }).dirty).toBe(false);

    writeFileSync(path.join(cwd, "new-file.txt"), "written by proposal\n");
    const after = await readPorcelain(cwd);
    const verdict = proposalDirtiedWorktree({
      cwd,
      baselineCwd: cwd,
      baselinePorcelain: baseline.ok ? baseline.porcelain : null,
      current: after,
    });
    expect(verdict.dirty).toBe(true);
  });
});
