// skills/manifest.ts — an installed community skill as the full list of its
// files, and the one way its folder is changed.
//
// An installed skill is a folder in the skill store. The source shipped some
// of its files; others were added later, by the owner or by an agent through
// skill_file_write (a workflow, a reference note). The folder is described by
// three trees, each a map from a posix-style relative path to a sha256:
//
//   - ORIGIN   — what the source shipped at install / at the last update
//                (agent_skills.installed_files, the manifest);
//   - UPSTREAM — what the source ships today (a fresh download);
//   - LOCAL    — what the folder holds now.
//
// planSkillFiles compares the three for EVERY file and says, per file, what an
// update does. The update check, the update preview, its apply and the
// reinstall of the same source all read that one plan: what the review shows
// is what the apply does. Two rules hold for every skill, source and OS:
//
//   1. A file the source did not ship is never deleted or overwritten: it is a
//      local addition, kept and listed.
//   2. A shipped file changed on both sides is a conflict. Nothing is written
//      for it until the person chooses (keep theirs, or take the new version).
//
// Applying a plan never edits the live folder in place: the new folder is
// built beside it (stageSkillFolder), checked file by file against what the
// plan promised, and switched in by rename (swapSkillFolder). The caller
// commits its database row only after the switch, and switches back if the
// commit fails: at every step a failure leaves the old folder (and the old
// row) as they were.

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SkillFileManifestEntry, SkillFilesState } from '@nodal-agents/db';
import { SkillInstallError } from './errors';

/** posix-style relative path → sha256 of the file's bytes. */
export type FileTree = Map<string, string>;

/** Absolute path of a posix-style relative path under `root`. */
function onDisk(root: string, rel: string): string {
  return join(root, ...rel.split('/'));
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Every regular file under `dir` (recursive), hashed. A missing `dir` is an
 * empty tree (a skill whose folder is gone holds no file). Any other read
 * error throws: a file that cannot be read is never taken for an absent one —
 * that confusion is how a failed copy used to read as the owner's own edit.
 * Symlinks and other non-regular entries are not files of the skill: they are
 * not listed, and a staged copy of the folder carries them over untouched.
 */
export async function readTree(
  dir: string,
  isExcluded?: (abs: string) => boolean,
): Promise<FileTree> {
  const tree: FileTree = new Map();
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (relDir === '' && isEnoent(err)) return;
      throw err;
    }
    for (const e of dirents) {
      const abs = join(absDir, e.name);
      if (isExcluded?.(abs)) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, rel);
      else if (e.isFile()) tree.set(rel, sha256(await readFile(abs)));
    }
  };
  await walk(dir, '');
  return tree;
}

/** The manifest stored in agent_skills.installed_files, sorted by path. */
export function toManifest(tree: FileTree): SkillFileManifestEntry[] {
  return [...tree.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, hash]) => ({ path, sha256: hash }));
}

/**
 * One hash for a whole tree: pins an apply to the upstream files the person
 * reviewed in the preview, as upstreamContentHash pins the text.
 */
export function treeHash(tree: FileTree): string {
  return sha256(
    toManifest(tree)
      .map((e) => `${e.path}\0${e.sha256}\n`)
      .join(''),
  );
}

/**
 * True when the filesystem holding `dir` folds case (Windows and macOS by
 * default): there, "Notes.md" and "notes.md" are ONE file, and a plan that
 * treated them as two would let a shipped file overwrite a local one. Probed,
 * not guessed from the platform: a case-sensitive volume exists on every OS.
 *
 * Read-only when the folder's own name has a letter: `dir` and the same name
 * with its case flipped are the same file exactly when the filesystem folds
 * case. Otherwise a probe file is written in `dir` and removed. A `dir` that
 * does not exist holds no file, so nothing in it can collide: false.
 */
export async function isCaseInsensitiveDir(dir: string): Promise<boolean> {
  const statOrNull = (p: string) =>
    stat(p, { bigint: true }).catch((err: unknown) => {
      if (isEnoent(err)) return null;
      throw err;
    });
  const real = await statOrNull(dir);
  if (real === null) return false;
  const name = basename(dir);
  const flipped = [...name]
    .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
    .join('');
  if (flipped !== name) {
    const other = await statOrNull(join(dirname(dir), flipped));
    return other !== null && other.ino === real.ino && other.dev === real.dev;
  }
  const probe = `.nodal-case-probe-${randomUUID()}`;
  await writeFile(join(dir, probe), '');
  try {
    return (await statOrNull(join(dir, probe.toUpperCase()))) !== null;
  } finally {
    await rm(join(dir, probe), { force: true });
  }
}

/** How a path is compared: the filesystem's own notion of "the same file". */
function keyOf(path: string, caseInsensitive: boolean): string {
  const n = path.normalize('NFC');
  return caseInsensitive ? n.toLowerCase() : n;
}

// ─── The plan ────────────────────────────────────────────────────────────────

/** Why a file is a conflict: both sides moved it away from what was shipped. */
export type FileConflictReason =
  /** Shipped file edited locally AND changed upstream. */
  | 'both-changed'
  /** Shipped file deleted locally, changed upstream. */
  | 'deleted-locally-changed-upstream'
  /** Shipped file edited locally, removed upstream. */
  | 'edited-locally-removed-upstream'
  /** A file added locally, and a different file at the same path added upstream. */
  | 'added-on-both-sides'
  /** Installed before the manifest existed: what was shipped is unknown, and
   *  the local copy differs from the new version. */
  | 'unknown-origin';

export type FileChange =
  /** New upstream, absent locally: written. */
  | { path: string; kind: 'added' }
  /** Changed upstream, untouched locally: written. */
  | { path: string; kind: 'changed' }
  /** Removed upstream, untouched locally: deleted. */
  | { path: string; kind: 'removed' }
  /** A shipped file edited or deleted locally, unchanged upstream: kept as it is. */
  | { path: string; kind: 'kept-local-change' }
  /** A file the source never shipped: kept. */
  | { path: string; kind: 'kept-local-addition' }
  /** Both sides moved it: the person chooses; nothing is written before. */
  | { path: string; kind: 'conflict'; reason: FileConflictReason };

export type ConflictChoice = 'keep-local' | 'take-upstream';

interface PlannedFile {
  change: FileChange;
  key: string;
  /** Exact local path when one exists (may differ in case from `change.path`). */
  localPath: string | null;
  /** Upstream hash when upstream ships the file. */
  upstreamHash: string | null;
}

export interface SkillFilesPlan {
  /** Every file whose fate is not "identical everywhere", sorted by path. */
  changes: FileChange[];
  state: SkillFilesState;
  /** Internal per-file detail, for stageSkillFolder. */
  readonly files: ReadonlyArray<PlannedFile>;
  readonly caseInsensitive: boolean;
}

export interface PlanInput {
  local: FileTree;
  upstream: FileTree;
  /** installed_files; null for a skill installed before the manifest existed. */
  origin: ReadonlyArray<SkillFileManifestEntry> | null;
  /**
   * For a skill with no manifest: the per-script origin hashes it does have
   * (installed_scripts.sha256). Ignored once a manifest exists.
   */
  legacyScriptOrigins?: ReadonlyArray<{ path: string; sha256?: string }> | null;
  caseInsensitive: boolean;
}

function byKey(
  entries: Iterable<[string, string]>,
  ci: boolean,
): Map<string, { path: string; hash: string }> {
  const m = new Map<string, { path: string; hash: string }>();
  for (const [path, hash] of entries) m.set(keyOf(path, ci), { path, hash });
  return m;
}

/** Decide, for every file of the three trees, what an update does with it. */
export function planSkillFiles(input: PlanInput): SkillFilesPlan {
  const ci = input.caseInsensitive;
  const local = byKey(input.local, ci);
  const upstream = byKey(input.upstream, ci);
  const hasManifest = input.origin !== null;
  const origin = hasManifest
    ? byKey(
        input.origin!.map((e) => [e.path, e.sha256] as [string, string]),
        ci,
      )
    : byKey(
        (input.legacyScriptOrigins ?? [])
          .filter((s): s is { path: string; sha256: string } => typeof s.sha256 === 'string')
          .map((s) => [s.path, s.sha256] as [string, string]),
        ci,
      );

  const keys = new Set([...local.keys(), ...upstream.keys(), ...origin.keys()]);
  const files: PlannedFile[] = [];
  for (const key of keys) {
    const U = upstream.get(key) ?? null;
    const L = local.get(key) ?? null;
    const O = origin.get(key) ?? null;
    const path = U?.path ?? O?.path ?? L!.path;
    const push = (change: FileChange): void => {
      files.push({
        change,
        key,
        localPath: L?.path ?? null,
        upstreamHash: U?.hash ?? null,
      });
    };

    // Identical on both sides: nothing to do, whatever the origin was.
    if (U && L && U.hash === L.hash) continue;

    if (!O) {
      // Not known to have been shipped: no manifest (installed before it
      // existed), or a path the manifest does not list.
      if (U && !L) push({ path, kind: 'added' });
      else if (U && L)
        push({
          path,
          kind: 'conflict',
          reason: hasManifest ? 'added-on-both-sides' : 'unknown-origin',
        });
      else if (L) push({ path: L.path, kind: 'kept-local-addition' });
      continue;
    }

    const localSame = L !== null && L.hash === O.hash;
    const upstreamSame = U !== null && U.hash === O.hash;
    if (localSame && upstreamSame) continue;
    if (localSame) {
      push(U ? { path, kind: 'changed' } : { path, kind: 'removed' });
    } else if (upstreamSame) {
      push({ path, kind: 'kept-local-change' });
    } else if (!U && !L) {
      continue; // removed on both sides
    } else {
      push({
        path,
        kind: 'conflict',
        reason: !L
          ? 'deleted-locally-changed-upstream'
          : !U
            ? 'edited-locally-removed-upstream'
            : 'both-changed',
      });
    }
  }

  files.sort((a, b) =>
    a.change.path < b.change.path ? -1 : a.change.path > b.change.path ? 1 : 0,
  );
  const changes = files.map((f) => f.change);
  return { changes, state: stateOf(changes), files, caseInsensitive: ci };
}

export function stateOf(changes: ReadonlyArray<FileChange>): SkillFilesState {
  if (changes.some((c) => c.kind === 'conflict')) return 'conflict';
  if (changes.some((c) => c.kind === 'added' || c.kind === 'changed' || c.kind === 'removed'))
    return 'update';
  if (changes.length > 0) return 'local-only';
  return 'clean';
}

/** The same plan, restricted to a set of paths (the skill's scripts). */
export function restrictPlan(
  plan: SkillFilesPlan,
  paths: Iterable<string>,
): ReadonlyArray<FileChange> {
  const keys = new Set([...paths].map((p) => keyOf(p, plan.caseInsensitive)));
  return plan.files.filter((f) => keys.has(f.key)).map((f) => f.change);
}

/**
 * The files of a folder that are the person's, not the source's: files the
 * source never shipped, and shipped files changed locally. For a skill
 * installed before the manifest, which files were shipped is unknown: every
 * file is listed (`originKnown: false`), except scripts whose recorded origin
 * hash still matches.
 *
 * The same plan as an update, against a source that now ships nothing: a
 * shipped file left untouched reads as `removed` (the source's, deleted with
 * the skill); a file added here as `kept-local-addition`; a shipped file
 * edited here as a conflict. Returned with that plan, for removeSkillFolder.
 */
export function personFilesOf(input: Omit<PlanInput, 'upstream'>): {
  plan: SkillFilesPlan;
  files: FileChange[];
} {
  const plan = planSkillFiles({ ...input, upstream: new Map() });
  const files = plan.changes.filter(
    (c) => c.kind === 'kept-local-addition' || c.kind === 'conflict',
  );
  return { plan, files };
}

// ─── Choices ─────────────────────────────────────────────────────────────────

export interface FileOp {
  kind: 'write' | 'delete';
  file: PlannedFile;
}

/**
 * The writes and deletes a plan makes once every conflict has its choice.
 * Refuses (and writes nothing) when a conflict has no choice, or when a choice
 * names a file that is not a conflict any more: the folder moved since the
 * review, and the person chose about a state that no longer exists.
 */
export function resolvePlan(
  plan: SkillFilesPlan,
  choices: Readonly<Record<string, ConflictChoice>>,
): FileOp[] {
  const conflicts = plan.files.filter((f) => f.change.kind === 'conflict');
  const conflictPaths = new Set(conflicts.map((f) => f.change.path));
  const unknown = Object.keys(choices).filter((p) => !conflictPaths.has(p));
  if (unknown.length > 0) {
    throw new SkillInstallError(
      `The skill's files changed since you reviewed this update: ${unknown.join(', ')} ` +
        `is no longer in conflict. Nothing was changed. Open the update again.`,
    );
  }
  const missing = conflicts.filter((f) => choices[f.change.path] === undefined);
  if (missing.length > 0) {
    throw new SkillInstallError(
      `These files were changed both in your copy and in the new version: ` +
        `${missing.map((f) => f.change.path).join(', ')}. Choose for each one whether to keep ` +
        `yours or take the new version. Nothing was changed.`,
    );
  }

  const ops: FileOp[] = [];
  for (const f of plan.files) {
    const k = f.change.kind;
    const takeUpstream =
      k === 'added' ||
      k === 'changed' ||
      k === 'removed' ||
      (k === 'conflict' && choices[f.change.path] === 'take-upstream');
    if (!takeUpstream) continue;
    if (f.upstreamHash !== null) ops.push({ kind: 'write', file: f });
    else if (f.localPath !== null) ops.push({ kind: 'delete', file: f });
  }
  return ops;
}

/** True when one of `ops` writes or deletes one of `paths` (compared as the filesystem does). */
export function opsTouch(
  plan: SkillFilesPlan,
  ops: ReadonlyArray<FileOp>,
  paths: Iterable<string>,
): boolean {
  const keys = new Set([...paths].map((p) => keyOf(p, plan.caseInsensitive)));
  return ops.some((o) => keys.has(o.file.key));
}

// ─── Staging and switching ───────────────────────────────────────────────────

/** Sibling paths of a skill folder used while it is replaced. Never a slug:
 *  slugs match /^[a-z0-9-]+$/, these start with a dot. */
function siblingDir(storeDir: string, slug: string, role: 'staging' | 'previous'): string {
  return join(storeDir, `.${slug}.${role}-${randomUUID()}`);
}

export interface StagedFolder {
  stagingDir: string;
  /** What the staged folder holds, checked file by file. */
  expected: FileTree;
}

/**
 * Build the folder the apply will switch in, BESIDE the live one (same parent,
 * so the switch is a rename on one volume, never a copy):
 *
 *   1. copy the live folder (local additions, kept edits, everything);
 *   2. apply the plan's writes and deletes;
 *   3. read the result back and compare it, file by file, with what the plan
 *      promised. A short copy, a file locked half-way, a file the agent wrote
 *      while this ran: any difference refuses the apply.
 *
 * On any failure the staging folder is removed and the error rethrown; the
 * live folder was only ever read.
 */
export async function stageSkillFolder(opts: {
  storeDir: string;
  slug: string;
  localDir: string;
  /** The live folder as planned (planSkillFiles' `local`). */
  local: FileTree;
  upstreamDir: string;
  ops: ReadonlyArray<FileOp>;
}): Promise<StagedFolder> {
  const stagingDir = siblingDir(opts.storeDir, opts.slug, 'staging');
  await mkdir(opts.storeDir, { recursive: true });
  try {
    const liveExists = await stat(opts.localDir).then(
      (s) => s.isDirectory(),
      (err: unknown) => {
        if (isEnoent(err)) return false;
        throw err;
      },
    );
    if (liveExists) {
      await cp(opts.localDir, stagingDir, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
    } else {
      await mkdir(stagingDir);
    }

    const expected: FileTree = new Map(opts.local);
    for (const op of opts.ops) {
      const f = op.file;
      if (f.localPath !== null) {
        // Same file under another case (a case-folding filesystem): drop the
        // local name first, so the shipped name is the one that lands.
        await rm(onDisk(stagingDir, f.localPath), { force: op.kind === 'write' });
        expected.delete(f.localPath);
      }
      if (op.kind === 'write') {
        const dest = onDisk(stagingDir, f.change.path);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(onDisk(opts.upstreamDir, f.change.path), dest);
        expected.set(f.change.path, f.upstreamHash!);
      }
    }

    const actual = await readTree(stagingDir);
    const wrong = [...new Set([...expected.keys(), ...actual.keys()])].filter(
      (p) => expected.get(p) !== actual.get(p),
    );
    if (wrong.length > 0) {
      throw new SkillInstallError(
        `The new copy of the skill "${opts.slug}" could not be prepared: ` +
          `${wrong.slice(0, 10).join(', ')} did not come out as expected. Nothing was changed.`,
      );
    }
    return { stagingDir, expected };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Build a brand-new skill folder beside where it will live: the upstream
 * files only, checked against the upstream tree. Same contract as
 * stageSkillFolder.
 */
export async function stageFreshSkillFolder(opts: {
  storeDir: string;
  slug: string;
  upstreamDir: string;
  upstream: FileTree;
}): Promise<StagedFolder> {
  const ops: FileOp[] = [...opts.upstream.entries()].map(([path, hash]) => ({
    kind: 'write',
    file: {
      change: { path, kind: 'added' },
      key: path,
      localPath: null,
      upstreamHash: hash,
    },
  }));
  return stageSkillFolder({
    storeDir: opts.storeDir,
    slug: opts.slug,
    // A path that never exists: the new folder starts empty.
    localDir: siblingDir(opts.storeDir, opts.slug, 'previous'),
    local: new Map(),
    upstreamDir: opts.upstreamDir,
    ops,
  });
}

/**
 * Windows refuses to rename a folder while any process holds a handle inside
 * it — a running skill script (whose working directory is the skill folder),
 * an editor, an antivirus or indexer scan — with EPERM, EACCES or EBUSY. Those
 * usually clear within moments, so the rename is retried for a short while
 * (the same codes graceful-fs retries). Nothing has changed until it succeeds.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1200];

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code ?? '';
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (!RENAME_RETRY_CODES.has(code) || delay === undefined) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export interface SwappedFolder {
  localDir: string;
  /** Where the previous live folder now is; null when there was none. */
  previousDir: string | null;
  /** True when a staged folder now sits at `localDir`; false when the live
   *  folder was only moved aside (a skill being removed). */
  installedNew: boolean;
}

/**
 * Switch the staged folder in by two renames: live → previous, staged → live.
 *
 * Between building the staging copy and the switch, something may have
 * written into the live folder (an agent's skill_file_write). The previous
 * folder is therefore re-read right after the first rename — from then on no
 * write can reach it — and compared with the tree the plan was built from. Any
 * difference switches back and refuses: that file would otherwise be lost.
 *
 * On failure the live folder is put back where it was before rethrowing.
 */
export async function swapSkillFolder(opts: {
  storeDir: string;
  slug: string;
  localDir: string;
  /** The folder to switch in; null to move the live folder aside only (removal). */
  stagingDir: string | null;
  /** The live folder as planned; null when no live folder may exist (fresh install). */
  planned: FileTree | null;
}): Promise<SwappedFolder> {
  const liveExists = await stat(opts.localDir).then(
    () => true,
    (err: unknown) => {
      if (isEnoent(err)) return false;
      throw err;
    },
  );
  if (liveExists && opts.planned === null) {
    throw new SkillInstallError(
      `The skill store already holds a folder for "${opts.slug}" that belongs to no installed ` +
        `skill (${opts.localDir}). Nothing was installed: move that folder away or remove it, ` +
        `then install again.`,
    );
  }
  let previousDir: string | null = null;
  if (liveExists) {
    previousDir = siblingDir(opts.storeDir, opts.slug, 'previous');
    try {
      await renameWithRetry(opts.localDir, previousDir);
    } catch (err) {
      throw new SkillInstallError(
        `The folder of the skill "${opts.slug}" is in use (a script of this skill may be ` +
          `running) and could not be moved: ${(err as Error).message}. Nothing was changed: ` +
          `try again once it has finished.`,
      );
    }
    const now = await readTree(previousDir);
    const planned = opts.planned ?? new Map<string, string>();
    const moved = [...new Set([...now.keys(), ...planned.keys()])].filter(
      (p) => now.get(p) !== planned.get(p),
    );
    if (moved.length > 0) {
      await renameWithRetry(previousDir, opts.localDir);
      throw new SkillInstallError(
        `The skill's files changed while the change was being prepared ` +
          `(${moved.slice(0, 10).join(', ')}). Nothing was changed: review it again.`,
      );
    }
  }
  if (opts.stagingDir === null) {
    return { localDir: opts.localDir, previousDir, installedNew: false };
  }
  try {
    await renameWithRetry(opts.stagingDir, opts.localDir);
  } catch (err) {
    if (previousDir !== null) await renameWithRetry(previousDir, opts.localDir);
    throw err;
  }
  return { localDir: opts.localDir, previousDir, installedNew: true };
}

/**
 * Undo a swap whose database commit failed: the new folder goes away and the
 * previous one comes back. Throws, naming both folders, if it cannot — the
 * person then knows exactly where their files are.
 */
export async function unswapSkillFolder(swapped: SwappedFolder): Promise<void> {
  const discard = join(
    dirname(swapped.localDir),
    `.${basename(swapped.localDir)}.discard-${randomUUID()}`,
  );
  try {
    if (swapped.installedNew) await renameWithRetry(swapped.localDir, discard);
    if (swapped.previousDir !== null) await renameWithRetry(swapped.previousDir, swapped.localDir);
  } catch (err) {
    throw new SkillInstallError(
      `The change was not saved, and the skill's previous folder could not be put back: it is ` +
        `at ${swapped.previousDir ?? '(none)'}` +
        `${swapped.installedNew ? `, the unsaved new one at ${discard}` : ''}. ` +
        `${(err as Error).message}`,
    );
  }
  await rm(discard, { recursive: true, force: true });
}

/**
 * After the commit: remove the previous folder. The update is complete either
 * way; a folder that cannot be removed now (locked on Windows) is returned so
 * the caller reports it instead of leaving it unnamed.
 */
export async function discardPreviousFolder(swapped: SwappedFolder): Promise<string | null> {
  if (swapped.previousDir === null) return null;
  try {
    await rm(swapped.previousDir, { recursive: true, force: true, maxRetries: 3 });
    return null;
  } catch {
    return swapped.previousDir;
  }
}
