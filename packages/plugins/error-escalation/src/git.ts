import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  baselineContentHash?: string | null;
  currentHead: string | null;
  current: PorcelainResult | null;
  currentContentHash?: string | null;
  headError?: string | null;
  contentHashError?: string | null;
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
  if (input.baselineContentHash) {
    if (!input.currentContentHash) {
      return { dirty: true, error: input.contentHashError ?? "Could not hash proposal contents" };
    }
    if (input.currentContentHash !== input.baselineContentHash) {
      return { dirty: true, error: "Proposal changed file contents" };
    }
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
  | { ok: true; path: string; head: string; porcelain: string; contentHash: string }
  | { ok: false; error: string };

export async function readWorktreeContentHash(
  cwd: string,
): Promise<{ ok: true; hash: string } | { ok: false; error: string }> {
  try {
    const { stdout: diff } = await execFileAsync("git", ["diff", "--binary", "HEAD"], {
      cwd,
      maxBuffer: DIFF_MAX_BUFFER,
      encoding: "buffer",
    });
    const { stdout: untracked } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd, maxBuffer: DIFF_MAX_BUFFER },
    );
    const hash = createHash("sha256");
    hash.update(diff);
    hash.update("\0");
    const rels = untracked.split("\0").filter((rel) => safeRelative(rel)).sort();
    for (const rel of rels) {
      const bytes = await readFile(path.join(cwd, rel));
      hash.update(rel);
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }
    return { ok: true, hash: hash.digest("hex") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "content hash failed" };
  }
}

const DIFF_MAX_BUFFER = 64 * 1024 * 1024;

async function gitApply(cwd: string, patch: Buffer | string): Promise<void> {
  if (!patch || (typeof patch === "string" ? patch.length === 0 : patch.length === 0)) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["apply", "--binary", "--whitespace=nowarn", "-"], { cwd });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git apply exited ${code}`));
    });
    child.stdin.end(patch);
  });
}

function safeRelative(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const normalized = path.normalize(rel);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

/**
 * Copy the source checkout's uncommitted files into a detached worktree.
 * Reads only: `git diff` and file copies. The source index and worktree stay
 * as they were. The caller snapshots porcelain after this returns.
 */
async function materializeSourceSnapshot(sourceCwd: string, destination: string): Promise<void> {
  const { stdout: patch } = await execFileAsync("git", ["diff", "--binary", "HEAD"], {
    cwd: sourceCwd,
    maxBuffer: DIFF_MAX_BUFFER,
    encoding: "buffer",
  });
  await gitApply(destination, patch);

  const { stdout: untracked } = await execFileAsync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: sourceCwd, maxBuffer: DIFF_MAX_BUFFER },
  );
  for (const rel of untracked.split("\0")) {
    if (!safeRelative(rel)) continue;
    const from = path.join(sourceCwd, rel);
    const to = path.join(destination, rel);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { dereference: false });
  }
}

export async function createProposalWorktree(sourceCwd: string): Promise<ProposalWorktree> {
  let destination = "";
  try {
    const parent = await mkdtemp(path.join(tmpdir(), "paperclip-escalation-"));
    destination = path.join(parent, "worktree");
    await execFileAsync("git", ["worktree", "add", "--detach", destination], { cwd: sourceCwd });
    await materializeSourceSnapshot(sourceCwd, destination);
    const head = await readHead(destination);
    const porcelain = await readPorcelain(destination);
    const content = await readWorktreeContentHash(destination);
    if (!head.ok || !porcelain.ok || !content.ok) {
      await removeProposalWorktree(sourceCwd, destination);
      const error = !head.ok
        ? head.error
        : !porcelain.ok
          ? porcelain.error
          : !content.ok
            ? content.error
            : "worktree snapshot failed";
      return { ok: false, error };
    }
    return {
      ok: true,
      path: destination,
      head: head.head,
      porcelain: porcelain.porcelain,
      contentHash: content.hash,
    };
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
