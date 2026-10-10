import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createProposalWorktree, proposalChangedIsolation, proposalDirtiedWorktree, readHead, readPorcelain, removeProposalWorktree } from "../src/git.js";

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

  it("runs the proposal in a throwaway worktree and notices a commit", async () => {
    const source = gitRepo();
    const sourceHead = await readHead(source);
    const created = await createProposalWorktree(source);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(path.join(created.path, "README.md"), "changed\n");
    const edited = await readPorcelain(created.path);
    expect(proposalChangedIsolation({
      baselineHead: created.head,
      baselinePorcelain: created.porcelain,
      currentHead: created.head,
      current: edited,
    }).dirty).toBe(true);
    execFileSync("git", ["add", "README.md"], { cwd: created.path });
    execFileSync("git", ["commit", "-m", "proposal"], { cwd: created.path });
    const committed = await readHead(created.path);
    expect(committed.ok && committed.head).not.toBe(created.head);
    expect(proposalChangedIsolation({
      baselineHead: created.head,
      baselinePorcelain: "",
      currentHead: committed.ok ? committed.head : null,
      current: { ok: true, porcelain: "" },
    }).dirty).toBe(true);
    const sourceAfter = await readPorcelain(source);
    const sourceHeadAfter = await readHead(source);
    expect(sourceAfter.ok).toBe(true);
    expect(sourceHead.ok).toBe(true);
    expect(sourceHeadAfter.ok).toBe(true);
    if (sourceAfter.ok) expect(sourceAfter.porcelain).toBe("");
    if (sourceHead.ok && sourceHeadAfter.ok) expect(sourceHeadAfter.head).toBe(sourceHead.head);
    await removeProposalWorktree(source, created.path);
    expect(existsSync(created.path)).toBe(false);
  });

  it("copies staged, unstaged, and untracked source files without changing the source", async () => {
    const source = gitRepo();
    writeFileSync(path.join(source, "staged.js"), "export const value = \"pass\";\n");
    writeFileSync(path.join(source, "unstaged.js"), "export const value = \"pass\";\n");
    execFileSync("git", ["add", "staged.js", "unstaged.js"], { cwd: source });
    execFileSync("git", ["commit", "-m", "passing"], { cwd: source });
    writeFileSync(path.join(source, "staged.js"), "export const value = \"staged-fail\";\n");
    execFileSync("git", ["add", "staged.js"], { cwd: source });
    writeFileSync(path.join(source, "unstaged.js"), "export const value = \"unstaged-fail\";\n");
    writeFileSync(path.join(source, "untracked.js"), "export const value = \"untracked-fail\";\n");
    const sourceHead = await readHead(source);
    const sourceBefore = await readPorcelain(source);
    const created = await createProposalWorktree(source);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(readFileSync(path.join(created.path, "staged.js"), "utf8")).toContain("staged-fail");
    expect(readFileSync(path.join(created.path, "unstaged.js"), "utf8")).toContain("unstaged-fail");
    expect(readFileSync(path.join(created.path, "untracked.js"), "utf8")).toContain("untracked-fail");
    expect(created.porcelain.length).toBeGreaterThan(0);
    const unchanged = await readPorcelain(created.path);
    expect(proposalChangedIsolation({
      baselineHead: created.head,
      baselinePorcelain: created.porcelain,
      currentHead: created.head,
      current: unchanged,
    }).dirty).toBe(false);
    const sourceAfter = await readPorcelain(source);
    const sourceHeadAfter = await readHead(source);
    expect(sourceBefore.ok && sourceAfter.ok && sourceAfter.porcelain).toBe(sourceBefore.ok ? sourceBefore.porcelain : "");
    expect(sourceHead.ok && sourceHeadAfter.ok && sourceHeadAfter.head).toBe(sourceHead.ok ? sourceHead.head : "");
    expect(sourceAfter.ok && sourceAfter.porcelain).toContain("staged.js");
    expect(sourceAfter.ok && sourceAfter.porcelain).toContain("untracked.js");
    await removeProposalWorktree(source, created.path);
  });

  it("fails closed when the source is not a git checkout", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "escalation-not-git-"));
    const created = await createProposalWorktree(cwd);
    expect(created.ok).toBe(false);
  });
});
