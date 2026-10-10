import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PorcelainResult =
  | { ok: true; porcelain: string }
  | { ok: false; error: string };

export async function readPorcelain(cwd: string): Promise<PorcelainResult> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
    return { ok: true, porcelain: stdout.trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "git status failed" };
  }
}

/**
 * Discard when git cannot be read, or when the worktree changed after the
 * proposal started. A tree that was already dirty is not itself a discard.
 */
export function proposalDirtiedWorktree(input: {
  cwd: string | null;
  baselineCwd: string | null;
  baselinePorcelain: string | null;
  current: PorcelainResult | null;
}): { dirty: boolean; error?: string } {
  if (!input.cwd) return { dirty: false };
  if (!input.current) return { dirty: true, error: "Workspace was not checked" };
  if (!input.current.ok) return { dirty: true, error: input.current.error };
  if (input.baselineCwd && input.cwd === input.baselineCwd && input.baselinePorcelain != null) {
    return { dirty: input.current.porcelain !== input.baselinePorcelain, error: input.current.porcelain !== input.baselinePorcelain ? "Workspace changed during the proposal" : undefined };
  }
  return {
    dirty: input.current.porcelain.length > 0,
    error: input.current.porcelain.length > 0 ? "Proposal workspace is dirty" : undefined,
  };
}

export async function readHead(cwd: string): Promise<{ ok: true; head: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const head = stdout.trim();
    if (!head) return { ok: false, error: "git rev-parse returned an empty HEAD" };
    return { ok: true, head };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "git rev-parse failed" };
  }
}

/**
 * Porcelain equality misses a commit (clean to clean, new HEAD) and an edit
 * of a file that was already dirty. Proposals run in a fresh detached
 * worktree so both show up against a known baseline.
 */
export function proposalChangedIsolation(input: {
  baselineHead: string | null;
  baselinePorcelain: string | null;
  currentHead: string | null;
  current: PorcelainResult | null;
  headError?: string | null;
}): { dirty: boolean; error?: string } {
  if (!input.current || !input.current.ok) {
    return {
      dirty: true,
      error: input.current && !input.current.ok ? input.current.error : "Workspace was not checked",
    };
  }
  if (!input.currentHead) {
    return { dirty: true, error: input.headError ?? "Could not read HEAD" };
  }
  if (input.baselineHead && input.currentHead !== input.baselineHead) {
    return { dirty: true, error: "Proposal commit changed HEAD" };
  }
  if (input.baselinePorcelain != null && input.current.porcelain !== input.baselinePorcelain) {
    return { dirty: true, error: "Workspace changed during the proposal" };
  }
  if (input.baselinePorcelain == null && input.current.porcelain.length > 0) {
    return { dirty: true, error: "Proposal workspace is dirty" };
  }
  return { dirty: false };
}

export type ProposalWorktree =
  | { ok: true; path: string; head: string; porcelain: string }
  | { ok: false; error: string };

export async function createProposalWorktree(sourceCwd: string): Promise<ProposalWorktree> {
  let destination = "";
  try {
    const parent = await mkdtemp(path.join(tmpdir(), "paperclip-escalation-"));
    destination = path.join(parent, "worktree");
    await execFileAsync("git", ["worktree", "add", "--detach", destination], { cwd: sourceCwd });
    const head = await readHead(destination);
    const porcelain = await readPorcelain(destination);
    if (!head.ok || !porcelain.ok) {
      await removeProposalWorktree(sourceCwd, destination);
      return { ok: false, error: !head.ok ? head.error : porcelain.ok ? "worktree snapshot failed" : porcelain.error };
    }
    return { ok: true, path: destination, head: head.head, porcelain: porcelain.porcelain };
  } catch (error) {
    if (destination) await removeProposalWorktree(sourceCwd, destination);
    return { ok: false, error: error instanceof Error ? error.message : "git worktree add failed" };
  }
}

export async function removeProposalWorktree(sourceCwd: string | null, worktreePath: string): Promise<void> {
  if (sourceCwd) {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: sourceCwd });
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
      try {
        await execFileAsync("git", ["worktree", "prune"], { cwd: sourceCwd });
      } catch {
        // The source repo may not be a git checkout anymore.
      }
    }
  } else {
    await rm(worktreePath, { recursive: true, force: true });
  }
  const parent = path.dirname(worktreePath);
  if (path.basename(parent).startsWith("paperclip-escalation-")) {
    await rm(parent, { recursive: true, force: true });
  }
}
