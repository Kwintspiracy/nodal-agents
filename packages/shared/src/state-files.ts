// state-files.ts — the ONE reader and writer of the files an install cannot
// live without.
//
// WHAT A STATE FILE IS. A file under the Nodal home whose loss locks the
// install out of its own data or makes it lie about what runs:
//
//   - `config.json`: ports, bind, secrets, and the only copy of the embedded
//     database's password;
//   - `secrets.key`: the master key every stored credential is encrypted with;
//   - `pids/processes.json`: what the last `up` started, so `down` stops it.
//
// THE RULE, the same for every one of them, on every operating system:
//
//   1. A file is replaced ATOMICALLY: the new bytes go to a temporary file in
//      the same folder, are flushed to disk, and the temporary file is renamed
//      over the target. A crash at any point leaves the old file or the new
//      one, never half of one.
//   2. The previous version is kept as the LAST GOOD COPY (`<file>.last-good`)
//      for a file that declares one, so a bad change can be undone by hand.
//   3. "Absent" and "unreadable or invalid" are two different answers. Absent
//      may mean a first install. A file that EXISTS but cannot be read or
//      understood is an error that names the file, says what is wrong, says
//      that nothing was changed, and says how to recover. It is never treated
//      as absent, and it is never written over (invariant #4).
//
// WINDOWS. `rename` replaces an existing destination there too (libuv calls
// MoveFileEx with MOVEFILE_REPLACE_EXISTING), and the target is never deleted
// first: deleting it would open a window with no file at all. What Windows
// adds is that another process can hold the target or the temporary file open
// without delete sharing: an antivirus scanning a file that just changed, a
// search indexer, a backup agent. The rename then fails with EPERM, EACCES or
// EBUSY for a few milliseconds. Those three codes are retried for a bounded
// time (`RENAME_RETRY_MS`); past it the write fails loud, the temporary file is
// removed and the target is left as it was.
//
// POSIX. After the rename, the folder itself is flushed, so the new directory
// entry survives a power cut and not only the new bytes.
//
// Not covered here: two programs changing the same file at the same moment.
// Each write is whole, so neither can leave a torn file, but the later of two
// concurrent read-modify-write cycles wins. The CLI and the dashboard write
// `config.json` on a person's action, seconds apart at least.

import {
  closeSync,
  chmodSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';
import { nodalHome, nodalHomeEntry } from './nodal-home';

type Env = Readonly<Record<string, string | undefined>>;

const pathFor = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix);

// ─── Where they live ─────────────────────────────────────────────────────────

/** `config.json`: `NODALAI_CONFIG_PATH` when set, else under the Nodal home. */
export function nodalConfigPath(
  env: Env = process.env,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return nodalHomeEntry('config.json', env, userHome, platform);
}

/** `secrets.key`, the master key, under the Nodal home. */
export function masterKeyFilePath(
  env: Env = process.env,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(nodalHome(env, userHome, platform), 'secrets.key');
}

/** `pids/processes.json`, what the last start recorded, under the Nodal home. */
export function processesFilePath(
  env: Env = process.env,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(nodalHome(env, userHome, platform), 'pids', 'processes.json');
}

/** Where the previous version of `path` is kept. */
export function lastGoodCopyPath(path: string): string {
  return `${path}.last-good`;
}

// ─── What each file is ───────────────────────────────────────────────────────

/** How one kind of state file is read, and what a person is told about it. */
export interface StateFileSpec<T> {
  /** What the file is, in a sentence: "Nodal's configuration". */
  readonly label: string;
  /**
   * Turn the bytes into a value, or throw an Error whose message says what is
   * wrong with them. Called on every read, and on every write BEFORE anything
   * touches the disk: a writer cannot leave a file its own reader refuses.
   */
  readonly parse: (text: string) => T;
  /**
   * Keep the previous version as `<file>.last-good` on every replace. False
   * only for a file whose content describes the PRESENT (which processes run
   * now): an old copy of it names processes that no longer exist, and putting
   * it back would be worse than having none.
   */
  readonly keepsLastGood: boolean;
  /** What to do when the file is unusable and no last good copy exists. */
  readonly recovery: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type StateFileErrorCode =
  | 'STATE_FILE_ABSENT'
  | 'STATE_FILE_UNREADABLE'
  | 'STATE_FILE_INVALID'
  | 'STATE_FILE_WRITE_FAILED'
  | 'STATE_FILE_EXISTS';

/**
 * A state file that cannot be used, or could not be written. The message names
 * the file, says what is wrong, says what was (not) changed, and how to recover.
 */
export class StateFileError extends Error {
  readonly code: StateFileErrorCode;
  readonly path: string;
  constructor(code: StateFileErrorCode, path: string, message: string) {
    super(message);
    this.name = 'StateFileError';
    this.code = code;
    this.path = path;
  }
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch (err) {
    return errnoOf(err) !== 'ENOENT';
  }
}

/** How to get back to a working file, for the messages below. */
function recoveryAdvice(path: string, spec: StateFileSpec<unknown>): string {
  if (spec.keepsLastGood && fileExists(lastGoodCopyPath(path))) {
    return (
      `The version before the last change is kept at ${lastGoodCopyPath(path)}. ` +
      `Check it, then copy it over ${path} and run the command again.`
    );
  }
  return spec.recovery;
}

function unusableError(
  code: 'STATE_FILE_UNREADABLE' | 'STATE_FILE_INVALID',
  path: string,
  spec: StateFileSpec<unknown>,
  reason: string,
): StateFileError {
  const what = code === 'STATE_FILE_UNREADABLE' ? 'cannot be read' : 'is not valid';
  return new StateFileError(
    code,
    path,
    `${spec.label} at ${path} exists but ${what}: ${reason}\n` +
      `Nothing was changed: the file was left exactly as it is, and nothing was written over it.\n` +
      recoveryAdvice(path, spec),
  );
}

/** How long a read or rename refused by a transient lock (Windows) is retried. */
export const RENAME_RETRY_MS = 3_000;

/** The codes Windows answers while another process holds the file open. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─── Read ────────────────────────────────────────────────────────────────────

/**
 * The bytes of `path`, or null when there is no file there. Any other failure
 * (permission, a folder in its place, a lock) is an error, never "absent".
 */
function readBytes(path: string, spec: StateFileSpec<unknown>): string | null {
  const deadline = Date.now() + RENAME_RETRY_MS;
  let wait = 10;
  for (;;) {
    try {
      return readFileSync(path, 'utf-8');
    } catch (err) {
      const code = errnoOf(err);
      if (code === 'ENOENT') return null;
      // EBUSY: another process holds the file with no read sharing (Windows,
      // a scanner); it lets go within milliseconds, so the read is retried.
      if (code === 'EBUSY' && Date.now() < deadline) {
        sleepSync(Math.min(wait, Math.max(1, deadline - Date.now())));
        wait = Math.min(wait * 2, 250);
        continue;
      }
      throw unusableError('STATE_FILE_UNREADABLE', path, spec, reasonOf(err));
    }
  }
}

/**
 * Read a state file. Null means ABSENT, and only that. A file that exists but
 * cannot be read or parsed throws `StateFileError`.
 */
export function readStateFile<T>(path: string, spec: StateFileSpec<T>): T | null {
  const text = readBytes(path, spec);
  if (text === null) return null;
  try {
    return spec.parse(text);
  } catch (err) {
    throw unusableError('STATE_FILE_INVALID', path, spec, reasonOf(err));
  }
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Points where a test can stop the writer (a child process killed there
 * proves what a crash at that instant leaves on disk). Never set in product
 * code.
 */
export interface StateFileWriteSeams {
  /** After the temporary file is written and flushed, before the rename. */
  readonly beforeRename?: (tempPath: string) => void;
}

/**
 * Restrict a file to its owner. `chmod 0600` on POSIX; on Windows the mode is
 * ignored and a fresh file inherits its folder's ACL, so an explicit owner-only
 * ACL is laid down with `icacls` (FA-5). Best-effort: a file whose ACL could
 * not be tightened keeps the profile's default, which is user-private.
 */
export function restrictFileToOwner(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* POSIX only; the Windows ACL below is what counts there */
  }
  if (process.platform !== 'win32') return;
  const user = process.env['USERNAME'] || process.env['USER'];
  if (!user) return;
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
  } catch {
    /* best-effort, see above */
  }
}

/** Write `data` to a NEW file at `path` (exclusive), flushed, owner-only. */
function writeNewFile(path: string, data: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    const bytes = Buffer.from(data, 'utf-8');
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  restrictFileToOwner(path);
}

function tempPathFor(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* a temporary file that cannot be removed is not worth a second failure */
  }
}

function renameWithRetry(from: string, to: string): void {
  const deadline = Date.now() + RENAME_RETRY_MS;
  let wait = 10;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = errnoOf(err);
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || Date.now() >= deadline) throw err;
      sleepSync(Math.min(wait, Math.max(1, deadline - Date.now())));
      wait = Math.min(wait * 2, 250);
    }
  }
}

/** Flush the folder so the renamed entry survives a power cut (POSIX). */
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return; // a folder cannot be opened for sync there
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } catch (err) {
    // Some file systems cannot sync a folder at all; the rename itself is done.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(errnoOf(err) ?? '')) throw err;
  } finally {
    closeSync(fd);
  }
}

/** Temporary file in the same folder, flushed, then renamed over `path`. */
function replaceAtomically(path: string, data: string, seams: StateFileWriteSeams): void {
  const tmp = tempPathFor(path);
  try {
    writeNewFile(tmp, data);
    seams.beforeRename?.(tmp);
    renameWithRetry(tmp, path);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  syncDirectory(dirname(path));
}

function writeFailed(path: string, err: unknown): StateFileError {
  return new StateFileError(
    'STATE_FILE_WRITE_FAILED',
    path,
    `Could not save ${path}: ${reasonOf(err)}\n` +
      `Nothing was changed: the file on disk is the one that was there before.`,
  );
}

/**
 * Replace a state file with `text`, atomically.
 *
 * `text` is parsed with the file's own reader first: a value its reader would
 * refuse is never written. When the file already exists it must itself be
 * readable and valid; an unusable file is NEVER written over, the error says
 * so. When the spec keeps a last good copy, the current version is saved as
 * `<file>.last-good` (atomically too) before the new one takes its place.
 */
export function replaceStateFile<T>(
  path: string,
  text: string,
  spec: StateFileSpec<T>,
  seams: StateFileWriteSeams = {},
): void {
  try {
    spec.parse(text);
  } catch (err) {
    throw new StateFileError(
      'STATE_FILE_INVALID',
      path,
      `Refused to save ${spec.label} at ${path}: the new content is not valid (${reasonOf(err)}).\n` +
        `Nothing was changed: the file on disk is the one that was there before.`,
    );
  }
  const current = readBytes(path, spec);
  if (current !== null) {
    try {
      spec.parse(current);
    } catch (err) {
      throw unusableError('STATE_FILE_INVALID', path, spec, reasonOf(err));
    }
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (current !== null && spec.keepsLastGood) {
      replaceAtomically(lastGoodCopyPath(path), current, {});
    }
    replaceAtomically(path, text, seams);
  } catch (err) {
    throw writeFailed(path, err);
  }
}

/**
 * Create a state file that must not exist yet, atomically and exclusively: the
 * content is written and flushed under a temporary name, then linked to
 * `path`, which fails if anything is already there. Two processes creating the
 * same file at once cannot both succeed, and a crash never leaves a partial
 * file at `path`. Throws `StateFileError` `STATE_FILE_EXISTS` when the file
 * exists (its content untouched).
 *
 * A file system without hard links (FAT, some network shares) fails the call
 * with the error of `link()`: no fallback onto a non-exclusive write
 * (invariant #4, same choice as `exclusive-create.ts`).
 */
export function createStateFile<T>(path: string, text: string, spec: StateFileSpec<T>): void {
  try {
    spec.parse(text);
  } catch (err) {
    throw new StateFileError(
      'STATE_FILE_INVALID',
      path,
      `Refused to create ${spec.label} at ${path}: the content is not valid (${reasonOf(err)}).`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  try {
    writeNewFile(tmp, text);
    try {
      linkSync(tmp, path);
    } catch (err) {
      if (errnoOf(err) === 'EEXIST') {
        throw new StateFileError(
          'STATE_FILE_EXISTS',
          path,
          `${spec.label} at ${path} already exists. Nothing was written over it.`,
        );
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof StateFileError) throw err;
    throw writeFailed(path, err);
  } finally {
    removeQuietly(tmp);
  }
  syncDirectory(dirname(path));
}
