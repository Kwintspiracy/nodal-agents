// pg-password.test.ts — a database password change survives being cut at any
// point, and a password is never invented for an existing database.
//
// The cluster is a model with ONE password, which `start` checks the way
// Postgres does (`--auth=password`), and the config is a real file written
// through `writeConfig`: each case asserts what the file holds and what the
// cluster holds, after a start cut at a given step and the start that follows.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig, type Config } from '../lib/config.ts';
import { LEGACY_PG_PASSWORD, PostgresAuthError } from '../lib/postgres.ts';
import {
  finishPasswordChange,
  passwordMismatchMessage,
  startWithPassword,
  type PasswordStartDeps,
} from '../lib/pg-password.ts';

class Cluster {
  starts: string[] = [];
  alterFails = false;
  constructor(public password: string) {}
  start = async (
    password: string,
  ): Promise<{ rotatePassword: (p: string) => Promise<boolean> }> => {
    this.starts.push(password);
    if (password !== this.password) {
      throw new PostgresAuthError('Postgres refused the connection: authentication failed');
    }
    return {
      rotatePassword: async (next: string) => {
        if (this.alterFails) return false;
        this.password = next;
        return true;
      },
    };
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nodal-pgpw-'));
  file = join(dir, 'config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function base(extra: Partial<Config> = {}): Config {
  return {
    ports: { web: 3000, runner: 3001, postgres: 25432 },
    workerSecret: 'w'.repeat(64),
    bind: 'loopback',
    ...extra,
  };
}

function onDisk(): Config {
  return JSON.parse(readFileSync(file, 'utf-8')) as Config;
}

function deps(
  cluster: Cluster,
  minted: string,
  warnings: string[] = [],
): PasswordStartDeps<Awaited<ReturnType<Cluster['start']>>> {
  return {
    start: cluster.start,
    save: (c) => writeConfig(c, file),
    mint: () => minted,
    warn: (m) => warnings.push(m),
  };
}

const NEW = 'N'.repeat(32);
const OLD = 'O'.repeat(32);

describe('a database password change @cap:installer-et-demarrer/moteur', () => {
  it('on a cluster still on the shipped password: recorded first, made, then confirmed', async () => {
    const cluster = new Cluster(LEGACY_PG_PASSWORD);
    writeConfig(base(), file);
    const d = deps(cluster, NEW);

    const started = await startWithPassword(base(), d);
    // Written BEFORE the change, beside (not over) the confirmed value.
    expect(onDisk().postgresPasswordPending).toBe(NEW);
    expect(onDisk().postgresPassword).toBeUndefined();

    const done = await finishPasswordChange(started, d);
    expect(done.password).toBe(NEW);
    expect(cluster.password).toBe(NEW);
    expect(onDisk().postgresPassword).toBe(NEW);
    expect(onDisk().postgresPasswordPending).toBeUndefined();
  });

  it('cut BEFORE the ALTER: the next start runs the change again', async () => {
    const cluster = new Cluster(LEGACY_PG_PASSWORD);
    writeConfig(base(), file);
    await startWithPassword(base(), deps(cluster, NEW)); // stopped here: no finish

    const next = await startWithPassword(onDisk(), deps(cluster, 'X'.repeat(32)));
    expect(next.acceptedPending).toBe(false);
    const done = await finishPasswordChange(next, deps(cluster, 'unused'));
    expect(done.password).toBe(NEW);
    expect(cluster.password).toBe(NEW);
    expect(onDisk()).toMatchObject({ postgresPassword: NEW });
    expect(onDisk().postgresPasswordPending).toBeUndefined();
  });

  it('cut AFTER the ALTER, before it was confirmed: the next start opens with the pending one', async () => {
    const cluster = new Cluster(LEGACY_PG_PASSWORD);
    writeConfig(base(), file);
    const started = await startWithPassword(base(), deps(cluster, NEW));
    await started.pg.rotatePassword(NEW); // the ALTER committed; the confirming write never ran

    const next = await startWithPassword(onDisk(), deps(cluster, 'X'.repeat(32)));
    expect(next.acceptedPending).toBe(true);
    expect(cluster.starts).toEqual([LEGACY_PG_PASSWORD, LEGACY_PG_PASSWORD, NEW]);
    const done = await finishPasswordChange(next, deps(cluster, 'unused'));
    expect(done.password).toBe(NEW);
    expect(onDisk().postgresPassword).toBe(NEW);
  });

  it('the same holds when moving away from a confirmed per-install password', async () => {
    const cluster = new Cluster(NEW);
    const config = base({ postgresPassword: OLD, postgresPasswordPending: NEW });
    writeConfig(config, file);

    const next = await startWithPassword(config, deps(cluster, 'unused'));
    expect(next.acceptedPending).toBe(true);
    const done = await finishPasswordChange(next, deps(cluster, 'unused'));
    expect(done.password).toBe(NEW);
    expect(onDisk().postgresPassword).toBe(NEW);
  });

  it('an ALTER that fails keeps the pending value recorded and says so', async () => {
    const cluster = new Cluster(LEGACY_PG_PASSWORD);
    cluster.alterFails = true;
    writeConfig(base(), file);
    const warnings: string[] = [];
    const started = await startWithPassword(base(), deps(cluster, NEW, warnings));
    const done = await finishPasswordChange(started, deps(cluster, NEW, warnings));
    expect(done.password).toBe(LEGACY_PG_PASSWORD);
    expect(onDisk().postgresPasswordPending).toBe(NEW);
    expect(warnings.join('\n')).toContain('retried on the next start');
  });

  it('a confirmed password the database accepts: no change, nothing written', async () => {
    const cluster = new Cluster(OLD);
    const config = base({ postgresPassword: OLD });
    writeConfig(config, file);
    const before = readFileSync(file, 'utf-8');
    const started = await startWithPassword(config, deps(cluster, 'unused'));
    const done = await finishPasswordChange(started, deps(cluster, 'unused'));
    expect(done.password).toBe(OLD);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('a database that accepts none of the held passwords stops the start; nothing is generated', async () => {
    const cluster = new Cluster('the-real-one-nobody-holds-any-more');
    const config = base({ postgresPassword: OLD });
    writeConfig(config, file);
    const before = readFileSync(file, 'utf-8');
    await expect(startWithPassword(config, deps(cluster, NEW))).rejects.toBeInstanceOf(
      PostgresAuthError,
    );
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(cluster.starts).toEqual([OLD]);
  });
});

describe('passwordMismatchMessage @cap:installer-et-demarrer/moteur', () => {
  it('names the file, says nothing changed, and points at the last good copy when there is one', () => {
    const m = passwordMismatchMessage('/h/config.json', '/h/config.json.last-good');
    expect(m).toContain('/h/config.json');
    expect(m).toContain('nothing was changed');
    expect(m).toContain('/h/config.json.last-good');
    expect(m).toContain('never creates a new password');
  });

  it('without a copy, points at a backup', () => {
    expect(passwordMismatchMessage('C:\\h\\config.json', null)).toContain(
      'backup of C:\\h\\config.json',
    );
  });
});
