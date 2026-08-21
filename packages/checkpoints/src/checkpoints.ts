// checkpoints.ts — transparent snapshots of a workspace, taken before an agent
// is allowed to change it.
//
// ## Why
//
// A `mode: "write"` run that goes wrong has no undo. The owner's only recourse
// is their own git history — if they happened to have committed, in a workspace
// that happens to be a repository. Most agent workspaces are neither. That gap
// is what decides whether someone dares let an agent write at all, which makes
// it worth more than the sum of its lines.
//
// Hermes solves it with a shadow git store (`tools/checkpoint_manager.py`) and
// the design here follows it, for reasons that survive inspection:
//
//   - **git, not a file copy.** Content-addressed storage deduplicates across
//     turns and across projects; a hundred snapshots of a repo cost roughly one
//     copy plus the deltas. Rolling back is a checkout, not a merge.
//   - **a SHADOW store, never the workspace's own `.git`.** The owner's history
//     is theirs. We never add a commit to it, never touch their index, never
//     move their HEAD. The cost is duplicated object storage on a workspace
//     that is already a repository; the benefit is that a checkpoint can never
//     corrupt something the user cares about.
//   - **not a tool.** The model never sees this, cannot call it, cannot skip
//     it. Anything the model can decide not to do is not a safety net.
//
// ## What it deliberately does not do
//
// It does not restore automatically. Deciding that a run went wrong is a human
// judgement, and an agent that could roll itself back could also roll back the
// evidence.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A snapshot that hangs must not hold a tool call. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Never snapshotted. Dependency trees and build output are large, regenerable,
 * and are exactly what makes a naive `add -A` take minutes on a real project.
 */
const EXCLUDES = [
  'node_modules/',
  '.git/',
  '.next/',
  'dist/',
  'build/',
  '__pycache__/',
  '.venv/',
  'target/',
  '*.log',
];

export interface Checkpoint {
  /** Commit sha in the shadow store. */
  sha: string;
  /** The workspace this snapshot belongs to. */
  workspace: string;
  /** ISO timestamp. */
  at: string;
  /** What was about to happen — the tool name and the job it belonged to. */
  label: string;
}

/**
 * One short, stable id per workspace path — the shadow store's ref name.
 *
 * The normalisation is the whole function, and it was wrong until a live test
 * caught it: lowercasing alone left `C:/Users/x` and `C:\Users\x` hashing
 * differently, so a snapshot taken through one spelling was invisible to a
 * `checkpoints list` that resolved the other. The store filled up and the
 * command reported nothing — no error, no clue.
 *
 * Windows treats both separators and both cases as the same path, so the key
 * must too. A trailing separator is dropped for the same reason.
 */
function workspaceKey(workspace: string): string {
  let norm = workspace;
  if (process.platform === 'win32') {
    norm = norm.toLowerCase().replace(/\//g, '\\');
  }
  norm = norm.replace(/[\\/]+$/, '');
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

async function git(store: string, workspace: string, args: string[]): Promise<string> {
  const key = workspaceKey(workspace);
  const { stdout } = await run('git', args, {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_DIR: join(store, 'store'),
      GIT_WORK_TREE: workspace,
      // A per-workspace index: two workspaces snapshotting at once must not
      // stomp on each other's staging area.
      GIT_INDEX_FILE: join(store, 'indexes', key),
      // A checkpoint is machinery, not authorship. Identity is fixed so it can
      // never depend on — or leak — the owner's git config.
      GIT_AUTHOR_NAME: 'Nodal checkpoints',
      GIT_AUTHOR_EMAIL: 'checkpoints@nodal.local',
      GIT_COMMITTER_NAME: 'Nodal checkpoints',
      GIT_COMMITTER_EMAIL: 'checkpoints@nodal.local',
      // The owner's global config must not change what we store or how.
      GIT_CONFIG_GLOBAL: join(store, 'gitconfig'),
      GIT_CONFIG_SYSTEM: join(store, 'gitconfig'),
    },
  });
  return stdout.trim();
}

/** Create the shared shadow store if it does not exist yet. Idempotent. */
export async function ensureStore(store: string): Promise<void> {
  const gitDir = join(store, 'store');
  await mkdir(join(store, 'indexes'), { recursive: true });
  await writeFile(join(store, 'gitconfig'), '', { flag: 'a' });
  if (!existsSync(join(gitDir, 'HEAD'))) {
    await mkdir(gitDir, { recursive: true });
    await run('git', ['init', '--bare', '--quiet', gitDir], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    // Excludes live in the store, not in the user's workspace: a checkpoint
    // must never add a file to a project it is protecting.
    await mkdir(join(gitDir, 'info'), { recursive: true });
    await writeFile(join(gitDir, 'info', 'exclude'), EXCLUDES.join('\n') + '\n', 'utf-8');
  }
}

/**
 * Snapshot `workspace` as it is right now. Returns the checkpoint, or null when
 * there was nothing to record (an unchanged tree since the last snapshot).
 *
 * Throws on a real failure. The caller is expected to refuse the write rather
 * than proceed without a net — a checkpoint that fails quietly is worse than no
 * checkpoint at all, because it is the one the owner thought they had.
 */
export async function snapshot(
  store: string,
  workspace: string,
  label: string,
): Promise<Checkpoint | null> {
  await ensureStore(store);
  const key = workspaceKey(workspace);
  const ref = `refs/nodal/${key}`;

  await git(store, workspace, ['add', '-A']);
  const tree = await git(store, workspace, ['write-tree']);

  // Nothing changed since the last checkpoint — recording it again would bury
  // the useful ones under identical noise.
  const parent = await git(store, workspace, ['rev-parse', '--verify', '--quiet', ref]).catch(
    () => '',
  );
  if (parent) {
    const parentTree = await git(store, workspace, ['rev-parse', `${parent}^{tree}`]).catch(
      () => '',
    );
    if (parentTree === tree) return null;
  }

  const at = new Date().toISOString();
  const args = ['commit-tree', tree, '-m', `${label} — ${at}`];
  if (parent) args.push('-p', parent);
  const sha = await git(store, workspace, args);
  await git(store, workspace, ['update-ref', ref, sha]);

  return { sha, workspace, at, label };
}

/** Checkpoints for a workspace, newest first. */
export async function listCheckpoints(
  store: string,
  workspace: string,
  limit = 20,
): Promise<Checkpoint[]> {
  if (!existsSync(join(store, 'store', 'HEAD'))) return [];
  const ref = `refs/nodal/${workspaceKey(workspace)}`;
  const out = await git(store, workspace, [
    'log',
    ref,
    `--max-count=${limit}`,
    '--format=%H%x00%aI%x00%s',
  ]).catch(() => '');
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, at, subject] = line.split('\0');
      return { sha: sha ?? '', workspace, at: at ?? '', label: subject ?? '' };
    });
}

/**
 * Restore `workspace` to a checkpoint.
 *
 * Takes a snapshot of the CURRENT state first, so the restore itself is
 * undoable — rolling back is a decision too, and the state it discards may be
 * the one worth keeping.
 */
export async function restoreCheckpoint(
  store: string,
  workspace: string,
  sha: string,
): Promise<{ restored: string; safety: Checkpoint | null }> {
  await ensureStore(store);
  const safety = await snapshot(store, workspace, `before restoring ${sha.slice(0, 8)}`);
  // -f: the working tree is expected to differ, that is the point.
  await git(store, workspace, ['checkout', '-f', sha, '--', '.']);
  return { restored: sha, safety };
}
