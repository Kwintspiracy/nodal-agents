// backup-restore-command.test.ts — what the two commands decide on their own,
// without a database: the config a restore leaves, where a passphrase comes
// from, the refusals before anything starts, and what `reset` says first.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAfterRestore } from '../commands/restore.ts';
import { resetWarning } from '../commands/reset.ts';
import { BACKUP_PASSPHRASE_ENV, readPassphrase, type PassphraseSource } from '../lib/passphrase.ts';
import type { Config } from '../lib/config.ts';

const live: Config = {
  ports: { web: 4100, runner: 4101, postgres: 26432 },
  workerSecret: 'w'.repeat(64),
  postgresPassword: 'this-machine-password',
  bind: 'loopback',
};
const archived = {
  ports: { web: 3000, runner: 3001, postgres: 25432 },
  workerSecret: 'a'.repeat(64),
  postgresPassword: 'the-other-machine-password',
  postgresPasswordPending: 'the-other-machine-pending',
  bind: 'lan',
  auth: { mode: 'local-auth' },
  llm: { provider: 'openrouter', baseURL: 'https://example.invalid/v1', model: 'm' },
  snapshots: { keep: 4 },
  aKeyOfANewerVersion: { kept: true },
} as unknown as Config;

describe('restore: the config it leaves @cap:installer-et-demarrer/moteur', () => {
  it("the backup's settings, this machine's ports and database password; keys this version does not know kept", () => {
    const next = configAfterRestore(live, archived);
    expect(next.ports).toEqual(live.ports);
    expect(next.postgresPassword).toBe('this-machine-password');
    expect(next.postgresPasswordPending).toBeUndefined();
    expect(next.workerSecret).toBe('a'.repeat(64));
    expect(next.bind).toBe('lan');
    expect(next.auth).toEqual({ mode: 'local-auth' });
    expect(next.llm?.provider).toBe('openrouter');
    expect(next.snapshots).toEqual({ keep: 4 });
    expect((next as Record<string, unknown>)['aKeyOfANewerVersion']).toEqual({ kept: true });
    // What is serialised carries no password of the other machine.
    expect(JSON.stringify(next)).not.toContain('the-other-machine');
  });

  it('a password change under way on THIS machine stays under way', () => {
    const next = configAfterRestore({ ...live, postgresPasswordPending: 'moving-here' }, archived);
    expect(next.postgresPasswordPending).toBe('moving-here');
  });
});

describe('backup: where the passphrase comes from @cap:installer-et-demarrer/moteur', () => {
  const source = (
    over: Partial<PassphraseSource>,
    answers: (string | undefined)[] = [],
  ): PassphraseSource => ({
    env: {},
    interactive: true,
    ask: async () => answers.shift(),
    ...over,
  });

  it('the variable first, without asking', async () => {
    const asked: string[] = [];
    const got = await readPassphrase(
      { confirm: true, purpose: 'x' },
      source({
        env: { [BACKUP_PASSPHRASE_ENV]: 'from env' },
        ask: async (m) => (asked.push(m), 'typed'),
      }),
    );
    expect(got).toBe('from env');
    expect(asked).toEqual([]);
  });

  it('no terminal and no variable: refused, the variable named', async () => {
    await expect(
      readPassphrase(
        { confirm: true, purpose: 'A protected backup' },
        source({ interactive: false }),
      ),
    ).rejects.toThrow(`Set ${BACKUP_PASSPHRASE_ENV}`);
  });

  it('typed twice when new: the same twice is taken, two different ones are refused, none is refused', async () => {
    expect(
      await readPassphrase({ confirm: true, purpose: 'x' }, source({}, ['s3cret', 's3cret'])),
    ).toBe('s3cret');
    await expect(
      readPassphrase({ confirm: true, purpose: 'x' }, source({}, ['s3cret', 'other'])),
    ).rejects.toThrow('The two passphrases differ');
    await expect(
      readPassphrase({ confirm: false, purpose: 'x' }, source({}, [undefined])),
    ).rejects.toThrow('none was typed');
    expect(await readPassphrase({ confirm: false, purpose: 'x' }, source({}, ['once']))).toBe(
      'once',
    );
  });
});

describe('reset: what it says before it asks @cap:installer-et-demarrer/moteur', () => {
  it('names the backups folder it deletes too, and the command that keeps a copy', () => {
    const text = resetWarning(join('/somewhere', 'home'));
    expect(text).toContain(join('/somewhere', 'home', 'backups'));
    expect(text).toContain('nodal-agents backup --to <a folder outside it>');
  });
});

describe('backup and restore: refused before anything starts @cap:installer-et-demarrer/moteur', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nodal-backup-cmd-'));
    const user = join(root, 'user');
    mkdirSync(user, { recursive: true });
    vi.stubEnv('NODALAI_HOME', join(root, 'home'));
    vi.stubEnv('USERPROFILE', user);
    vi.stubEnv('HOME', user);
    vi.stubEnv('NODALAI_CONFIG_PATH', undefined);
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('backup with no install in the home: refused, nothing written', async () => {
    const { runBackup } = await import('../commands/backup.ts');
    await expect(runBackup({ to: join(root, 'out') })).rejects.toThrow('nothing to back up');
    expect(readdirSync(root).sort()).toEqual(['user']);
  });

  it('restore of a file that does not exist: refused before anything is created', async () => {
    const { runRestore } = await import('../commands/restore.ts');
    await expect(runRestore(join(root, 'nope.nodalbak'))).rejects.toThrow('There is no file at');
    expect(readdirSync(root).sort()).toEqual(['user']);
  });

  it('restore of a file that is not a backup: refused before anything is created', async () => {
    const { writeFileSync } = await import('node:fs');
    const path = join(root, 'notes.txt');
    writeFileSync(path, 'hello');
    const { runRestore } = await import('../commands/restore.ts');
    await expect(runRestore(path)).rejects.toThrow('BACKUP_NOT_AN_ARCHIVE');
    expect(readdirSync(root).sort()).toEqual(['notes.txt', 'user']);
  });
});
