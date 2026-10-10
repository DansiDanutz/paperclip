import { execFile } from "node:child_process";
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
