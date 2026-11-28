// nodal-config-file.test.ts — `config.json` through its one reader and writer.
//
// The file holds the only copy of the database password. These cases prove
// the three events that used to lose it cannot any more: a save cut at any
// byte, a file written by another version, a hand edit.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodalConfig } from '../nodal-config';
import {
  createNodalConfigFile,
  readNodalConfigFile,
  serializeNodalConfig,
  updateNodalConfigFile,
  writeNodalConfigFile,
} from '../nodal-config-file';
import { StateFileError, lastGoodCopyPath } from '../state-files';

const PASSWORD = 'the-only-copy-of-the-db-password';

function aConfig(): NodalConfig {
  return {
    ports: { web: 3000, runner: 3001, postgres: 25432 },
    workerSecret: 'w'.repeat(64),
    serverActionsKey: 'a'.repeat(43) + '=',
    authSecret: 'b'.repeat(43) + '=',
    postgresPassword: PASSWORD,
    bind: 'loopback',
  };
}

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nodal-config-file-'));
  const home = join(root, 'Nodal Zoë 数据');
  mkdirSync(home);
  file = join(home, 'config.json');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function refusal(fn: () => unknown): StateFileError {
  try {
    fn();
  } catch (err) {
    if (err instanceof StateFileError) return err;
    throw err;
  }
  throw new Error('expected a StateFileError, nothing was thrown');
}

describe('config.json: a save cut short @cap:installer-et-demarrer/moteur', () => {
  it('a file truncated at EVERY byte position is refused, never read as absent, and left as it is', () => {
    const whole = serializeNodalConfig(aConfig());
    const bytes = Buffer.from(whole, 'utf-8');
    for (let cut = 0; cut < bytes.length - 1; cut++) {
      const partial = bytes.subarray(0, cut);
      writeFileSync(file, partial);
      const err = refusal(() => readNodalConfigFile(file));
      expect(err.code, `cut at byte ${cut}`).toBe('STATE_FILE_INVALID');
      // And no writer goes over it either.
      expect(() => writeNodalConfigFile(file, aConfig())).toThrow(StateFileError);
      expect(readFileSync(file).equals(partial), `cut at byte ${cut}`).toBe(true);
    }
    // The last byte is the trailing newline: without it the JSON is whole.
    writeFileSync(file, bytes.subarray(0, bytes.length - 1));
    expect(readNodalConfigFile(file)?.postgresPassword).toBe(PASSWORD);
  });
});

describe('config.json: a file written by another version @cap:installer-et-demarrer/moteur', () => {
  it('keeps keys it does not know, at the top and inside known sections, across a write', () => {
    writeFileSync(
      file,
      JSON.stringify({
        ...aConfig(),
        ports: { web: 3000, runner: 3001, postgres: 25432, voice: 3005 },
        auth: { mode: 'local-auth', passkeys: true },
        futureSection: { enabled: true, level: 3 },
      }),
    );
    updateNodalConfigFile(file, (c) => ({ ...c, bind: 'lan' }));
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(onDisk['futureSection']).toEqual({ enabled: true, level: 3 });
    expect(onDisk['ports']).toEqual({ web: 3000, runner: 3001, postgres: 25432, voice: 3005 });
    expect(onDisk['auth']).toEqual({ mode: 'local-auth', passkeys: true });
    expect(onDisk['bind']).toBe('lan');
    expect(onDisk['postgresPassword']).toBe(PASSWORD);
  });

  it('a value this version refuses stops the read with the key named, file untouched', () => {
    const text = JSON.stringify({ ...aConfig(), bind: 'everywhere' });
    writeFileSync(file, text);
    const err = refusal(() => readNodalConfigFile(file));
    expect(err.code).toBe('STATE_FILE_INVALID');
    expect(err.message).toContain('bind');
    expect(readFileSync(file, 'utf-8')).toBe(text);
  });
});

describe('config.json: a hand edit @cap:installer-et-demarrer/moteur', () => {
  it('a trailing comma is refused with the file named, the last good copy offered, and it works', () => {
    writeNodalConfigFile(file, aConfig());
    writeNodalConfigFile(file, { ...aConfig(), bind: 'lan', auth: { mode: 'local-auth' } });
    const broken = readFileSync(file, 'utf-8').replace(/\n}\n$/, ',\n}\n');
    writeFileSync(file, broken);

    const err = refusal(() => readNodalConfigFile(file));
    expect(err.message).toContain(file);
    expect(err.message).toContain('not valid JSON');
    expect(err.message).toContain('Nothing was changed');
    expect(err.message).toContain(lastGoodCopyPath(file));
    expect(readFileSync(file, 'utf-8')).toBe(broken);

    // The recovery the message describes: copy the last good version over it.
    writeFileSync(file, readFileSync(lastGoodCopyPath(file)));
    expect(readNodalConfigFile(file)?.postgresPassword).toBe(PASSWORD);
  });
});

describe('config.json: three services, three ports @cap:installer-et-demarrer/moteur', () => {
  it('a config giving two services one port is refused, by the reader and by the writer', () => {
    writeFileSync(
      file,
      JSON.stringify({ ...aConfig(), ports: { web: 3001, runner: 3001, postgres: 25432 } }),
    );
    expect(refusal(() => readNodalConfigFile(file)).message).toContain('three different ports');

    rmSync(file);
    writeNodalConfigFile(file, aConfig());
    const before = readFileSync(file, 'utf-8');
    const err = refusal(() =>
      updateNodalConfigFile(file, (c) => ({ ...c, ports: { ...c.ports, web: c.ports.runner } })),
    );
    expect(err.code).toBe('STATE_FILE_INVALID');
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });
});

describe('config.json: creating and changing @cap:installer-et-demarrer/moteur', () => {
  it('creating never replaces an existing file', () => {
    writeNodalConfigFile(file, aConfig());
    const before = readFileSync(file, 'utf-8');
    const err = refusal(() =>
      createNodalConfigFile(file, { ...aConfig(), postgresPassword: 'x'.repeat(32) }),
    );
    expect(err.code).toBe('STATE_FILE_EXISTS');
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('changing an absent file is refused as absent: the CLI creates it, nobody else', () => {
    expect(refusal(() => updateNodalConfigFile(file, (c) => c)).code).toBe('STATE_FILE_ABSENT');
  });
});
