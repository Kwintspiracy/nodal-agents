// lib/workspace-git.ts — is this workspace a git repository, and in what state?
// Injected into the system prompt at job start (JobContext.workspaceGit).
//
// Why: an agent working in a repo does not know it is in one. Verified across
// packages/orchestration on 2026-08-21 — zero mention of git, branch, or
// repository anywhere in the prompt builder. So it commits to `main` without
// noticing, reasons about "the current code" while the tree is half-modified,
// and cannot say which branch its work landed on. Hermes solves this with a
// "coding posture" that carries a workspace snapshot; this is the same idea,
// placed where Nodal's architecture puts it.
//
// Cost/cache: computed ONCE per job, and rendered in the VOLATILE half of the
// system prompt — after SYSTEM_PROMPT_CACHE_BOUNDARY, next to the workspace
// inventory. That placement is deliberate and was corrected during planning:
// the stable half is shared ACROSS an agent's jobs, so a branch name there
// would be served stale to every later job. Branch and dirty state also drift
// mid-session, which is why the rendered block tells the model to re-check with
// `git` before acting on it rather than trusting the snapshot.
//
// Layering: this file is impure (it spawns `git`), which is why it lives in the
// runner and not in packages/orchestration — that package has no `fs` and no
// `child_process`, and putting a probe there would have broken the seam. Same
// split as the inventory: the runner computes, the orchestration renders.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A probe that hangs must not hold a job's start. */
const GIT_TIMEOUT_MS = 5_000;

export interface WorkspaceGitState {
  /** Absolute path of the repository root. */
  root: string;
  /** Current branch, or null in detached HEAD. */
  branch: string | null;
  /**
   * Number of entries `git status --porcelain` reports. 0 = clean.
   *
   * NULL when the status probe itself failed or timed out — which is NOT the
   * same as clean, and must never be rendered as such. It was a plain `number`
   * at first, defaulting to 0 on failure: a timed-out `git status` and a
   * genuinely clean tree produced the identical value, so the prompt announced
   * "working tree: clean" over an unknown state and the agent acted on it.
   * That is invariant #4 (fail loud, no silent smart fallback) broken in the
   * one place it matters most — the sentence the agent trusts before writing.
   */
  dirtyCount: number | null;
  /** Short SHA of HEAD, or null in a repo with no commits yet. */
  head: string | null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return stdout.trim();
  } catch {
    // Not a repo, no git on PATH, timeout — all mean "no usable answer", and
    // none of them should surface as a job failure. The caller renders nothing.
    return null;
  }
}

/**
 * Probe `cwd` for a git repository. Returns null when there is none, when git
 * is unavailable, or when the probe times out.
 *
 * Deliberately reads only what changes the agent's behaviour: where the repo
 * starts, which branch it is on, whether the tree is dirty. Not the log, not
 * the remotes, not the diff — a system prompt is not a dashboard, and every
 * extra line is paid on every turn of every job.
 */
export async function probeWorkspaceGit(cwd: string): Promise<WorkspaceGitState | null> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;

  const [branchRaw, statusRaw, headRaw] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['rev-parse', '--short', 'HEAD']),
  ]);

  return {
    root,
    // `HEAD` is what --abbrev-ref prints in a detached checkout; that is not a
    // branch name and must not be presented as one.
    branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
    // `null` (probe failed) and `''` (clean tree) are different answers and
    // must not collapse into the same number — hence the explicit null check
    // rather than a truthiness test on a string that is empty when clean.
    dirtyCount:
      statusRaw === null ? null : statusRaw.split('\n').filter((l) => l.trim() !== '').length,
    head: headRaw,
  };
}
