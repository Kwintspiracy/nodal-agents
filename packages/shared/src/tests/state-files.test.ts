// state-files.test.ts — the rule every state file follows: replaced whole,
// last good copy kept, an unusable file is an error and is never written over.
//
// Every case works on a real folder in the temporary directory, with a name
// that holds a space and non-ASCII characters, and asserts the BYTES on disk.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RENAME_RETRY_MS,
  StateFileError,
  createStateFile,
  lastGoodCopyPath,
  masterKeyFilePath,
  nodalConfigPath,
  processesFilePath,
  readStateFile,
  replaceStateFile,
  type StateFileSpec,
} from '../state-files';

/** A JSON object with a `n` number: small enough to read, strict enough to refuse. */
const COUNTER: StateFileSpec<{ n: number }> = {
  label: 'The test counter',
  parse: (text) => {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== 'object' || v === null || typeof (v as { n?: unknown }).n !== 'number') {
      throw new Error('it has no number "n"');
    }
    return v as { n: number };
  },
  keepsLastGood: true,
  recovery: 'Recover it the test way.',
};

const NO_COPY: StateFileSpec<{ n: number }> = { ...COUNTER, keepsLastGood: false };

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nodal-state-'));
  // A space and non-ASCII characters, as a real profile folder can have.
  dir = join(root, 'Dossier de Zoë 名前');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function catchError(fn: () => unknown): StateFileError {
  try {
    fn();
  } catch (err) {
    if (err instanceof StateFileError) return err;
    throw err;
  }
  throw new Error('expected a StateFileError, nothing was thrown');
}

describe('readStateFile @cap:installer-et-demarrer/moteur', () => {
  it('answers null for an absent file, and only then', () => {
    expect(readStateFile(join(dir, 'state.json'), COUNTER)).toBeNull();
  });

  it('refuses an EMPTY file: present and invalid, never absent', () => {
    const file = join(dir, 'state.json');
    writeFileSync(file, '');
    const err = catchError(() => readStateFile(file, COUNTER));
    expect(err.code).toBe('STATE_FILE_INVALID');
    expect(readFileSync(file, 'utf-8')).toBe('');
  });

  it('refuses a file that cannot be read (a folder in its place) as unreadable', () => {
    const file = join(dir, 'state.json');
    mkdirSync(file);
    expect(catchError(() => readStateFile(file, COUNTER)).code).toBe('STATE_FILE_UNREADABLE');
  });

  it('names the file, says nothing was changed, and points at the last good copy', () => {
    const file = join(dir, 'state.json');
    replaceStateFile(file, '{"n":1}', COUNTER);
    replaceStateFile(file, '{"n":2}', COUNTER);
    writeFileSync(file, '{"n":2,}');
    const err = catchError(() => readStateFile(file, COUNTER));
    expect(err.path).toBe(file);
    expect(err.message).toContain(file);
    expect(err.message).toContain('is not valid');
    expect(err.message).toContain('Nothing was changed');
    expect(err.message).toContain(lastGoodCopyPath(file));
    expect(err.message).not.toContain('Recover it the test way.');
  });

  it('gives the file’s own recovery when it keeps no copy', () => {
    const file = join(dir, 'state.json');
    writeFileSync(file, 'not json');
    const err = catchError(() => readStateFile(file, NO_COPY));
    expect(err.message).toContain('Recover it the test way.');
  });
});

describe('replaceStateFile @cap:installer-et-demarrer/moteur', () => {
  it('writes the new bytes and keeps the previous version as the last good copy', () => {
    const file = join(dir, 'state.json');
    replaceStateFile(file, '{"n":1}', COUNTER);
    expect(existsSync(lastGoodCopyPath(file))).toBe(false);
    replaceStateFile(file, '{"n":2}', COUNTER);
    expect(readFileSync(file, 'utf-8')).toBe('{"n":2}');
    expect(readFileSync(lastGoodCopyPath(file), 'utf-8')).toBe('{"n":1}');
    replaceStateFile(file, '{"n":3}', COUNTER);
    expect(readFileSync(lastGoodCopyPath(file), 'utf-8')).toBe('{"n":2}');
  });

  it('the last good copy restores a working file', () => {
    const file = join(dir, 'state.json');
    replaceStateFile(file, '{"n":1}', COUNTER);
    replaceStateFile(file, '{"n":2}', COUNTER);
    writeFileSync(file, '{');
    writeFileSync(file, readFileSync(lastGoodCopyPath(file)));
    expect(readStateFile(file, COUNTER)).toEqual({ n: 1 });
  });

  it('keeps no copy for a file that declares none', () => {
    const file = join(dir, 'state.json');
    replaceStateFile(file, '{"n":1}', NO_COPY);
    replaceStateFile(file, '{"n":2}', NO_COPY);
    expect(existsSync(lastGoodCopyPath(file))).toBe(false);
  });

  it('never writes content its own reader would refuse', () => {
    const file = join(dir, 'state.json');
    replaceStateFile(file, '{"n":1}', COUNTER);
    const err = catchError(() => replaceStateFile(file, '{"n":"one"}', COUNTER));
    expect(err.code).toBe('STATE_FILE_INVALID');
    expect(readFileSync(file, 'utf-8')).toBe('{"n":1}');
  });

  it('never writes over an existing file that is unusable, and leaves it byte-identical', () => {
    const file = join(dir, 'state.json');
    const broken = Buffer.from('{"n": 1,,}');
    writeFileSync(file, broken);
    const err = catchError(() => replaceStateFile(file, '{"n":2}', COUNTER));
    expect(err.code).toBe('STATE_FILE_INVALID');
    expect(readFileSync(file).equals(broken)).toBe(true);
    expect(existsSync(lastGoodCopyPath(file))).toBe(false);
  });

  it('leaves no temporary file behind', () => {
    const file = join(dir, 'state.json');
    replaceStateFile(file, '{"n":1}', COUNTER);
    replaceStateFile(file, '{"n":2}', COUNTER);
    expect(readdirSync(dir).sort()).toEqual(['state.json', 'state.json.last-good']);
  });

  it('a failure at the seam (before the rename) leaves the old file whole and no temporary', () => {
    const file = join(dir, 'state.json');
    replaceStateFile(file, '{"n":1}', COUNTER);
    const err = catchError(() =>
      replaceStateFile(file, '{"n":2}', COUNTER, {
        beforeRename: () => {
          throw new Error('disk gone');
        },
      }),
    );
    expect(err.code).toBe('STATE_FILE_WRITE_FAILED');
    expect(err.message).toContain('Nothing was changed');
    expect(readFileSync(file, 'utf-8')).toBe('{"n":1}');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('createStateFile @cap:installer-et-demarrer/moteur', () => {
  it('creates a file that was absent', () => {
    const file = join(dir, 'new.json');
    createStateFile(file, '{"n":7}', COUNTER);
    expect(readStateFile(file, COUNTER)).toEqual({ n: 7 });
    expect(readdirSync(dir)).toEqual(['new.json']);
  });

  it('refuses when anything is already there, and leaves it untouched', () => {
    const file = join(dir, 'new.json');
    writeFileSync(file, 'theirs');
    const err = catchError(() => createStateFile(file, '{"n":7}', COUNTER));
    expect(err.code).toBe('STATE_FILE_EXISTS');
    expect(readFileSync(file, 'utf-8')).toBe('theirs');
    expect(readdirSync(dir)).toEqual(['new.json']);
  });
});

describe('where the state files live, on every OS path form @cap:installer-et-demarrer/moteur', () => {
  it('Windows paths, with a space and non-ASCII characters in the home', () => {
    const env = { NODALAI_HOME: 'C:\\Users\\Zoë Lefèvre\\Nodal données' };
    expect(nodalConfigPath(env, 'C:\\Users\\x', 'win32')).toBe(
      'C:\\Users\\Zoë Lefèvre\\Nodal données\\config.json',
    );
    expect(masterKeyFilePath(env, 'C:\\Users\\x', 'win32')).toBe(
      'C:\\Users\\Zoë Lefèvre\\Nodal données\\secrets.key',
    );
    expect(processesFilePath(env, 'C:\\Users\\x', 'win32')).toBe(
      'C:\\Users\\Zoë Lefèvre\\Nodal données\\pids\\processes.json',
    );
  });

  it('POSIX paths, and NODALAI_CONFIG_PATH moving the config alone', () => {
    const env = { NODALAI_HOME: '/home/zoë/Nodal data', NODALAI_CONFIG_PATH: '/etc/nodal/c.json' };
    expect(nodalConfigPath(env, '/home/zoë', 'linux')).toBe('/etc/nodal/c.json');
    expect(masterKeyFilePath(env, '/home/zoë', 'darwin')).toBe('/home/zoë/Nodal data/secrets.key');
    expect(processesFilePath(env, '/home/zoë', 'linux')).toBe(
      '/home/zoë/Nodal data/pids/processes.json',
    );
  });
});

/**
 * Hold `file` open from another process, the way an antivirus or an indexer
 * does: `Read` lets others read it but not replace it; `None` lets nobody in.
 */
function holdLocked(
  file: string,
  ms: number,
  share: 'Read' | 'None',
): Promise<{ released: Promise<void>; marker: string }> {
  const marker = join(root, `locked-${Date.now()}`);
  const script =
    `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', '${share}');` +
    `[System.IO.File]::WriteAllText('${marker.replace(/'/g, "''")}', 'x');` +
    `Start-Sleep -Milliseconds ${ms}; $f.Close()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
  });
  const released = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      if (existsSync(marker)) return resolve({ released, marker });
      if (Date.now() - started > 20_000) return reject(new Error('the lock was never taken'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

describe.skipIf(process.platform !== 'win32')(
  'Windows: a file held open by another process @cap:installer-et-demarrer/moteur',
  () => {
    it('is replaced once the other process lets go (bounded retry)', async () => {
      const file = join(dir, 'state.json');
      replaceStateFile(file, '{"n":1}', NO_COPY);
      const lock = await holdLocked(file, 600, 'Read');
      replaceStateFile(file, '{"n":2}', NO_COPY);
      expect(readFileSync(file, 'utf-8')).toBe('{"n":2}');
      await lock.released;
    }, 30_000);

    it('past the retry budget, fails loud and leaves the old file and no temporary', async () => {
      const file = join(dir, 'state.json');
      replaceStateFile(file, '{"n":1}', NO_COPY);
      const lock = await holdLocked(file, RENAME_RETRY_MS + 4_000, 'Read');
      const err = catchError(() => replaceStateFile(file, '{"n":2}', NO_COPY));
      await lock.released;
      expect(err.code).toBe('STATE_FILE_WRITE_FAILED');
      expect(readFileSync(file, 'utf-8')).toBe('{"n":1}');
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    }, 30_000);

    it('is read once a process that let nobody in lets go', async () => {
      const file = join(dir, 'state.json');
      replaceStateFile(file, '{"n":1}', NO_COPY);
      const lock = await holdLocked(file, 600, 'None');
      expect(readStateFile(file, NO_COPY)).toEqual({ n: 1 });
      await lock.released;
    }, 30_000);
  },
);
