// backup-restore.pg.test.ts — the two commands, run as the real CLI binary,
// from one home to ANOTHER home on a different data folder that holds nothing
// yet (a new machine), on real embedded clusters.
//
// Home A is an install: its config, its cluster, the real schema, a master key
// and a credential encrypted with it. `backup` (the real binary, the stack
// stopped) writes a file; `restore` of that file into home B, which has no
// config and no cluster, makes B an install first, then brings A back in it.
// What is checked afterwards, from B's own files and B's own cluster: the
// rows, the key, the credential decrypting, and the config carrying A's
// settings with B's own ports and database password. Then `restore` while a
// process recorded as B's runner is alive: refused, nothing touched.
//
// The homes have spaces in their names; the user profile is a
// temporary folder too (the registry of instances lives there). The process
// standing in for a running stack is a child started here, stopped by its pid.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { waitForFile, withPostgresClusterStart } from '@nodal-agents/test-kit';
import {
  assertMasterKeyRestorable,
  createClient,
  credentials,
  encryptChannelSecret,
  getAppSetting,
  setAppSetting,
} from '@nodal-agents/db';
import { findFreePort } from '../lib/ports.ts';

const cliDir = fileURLToPath(new URL('../..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'nodal-backup-cli-'));
const user = join(root, 'user');
// No accent in a home holding a CLUSTER: on Windows the postmaster cannot open
// its log under a non-ASCII path (a separate defect, reported, not this one).
const homeA = join(root, 'home A');
const homeB = join(root, 'home B');
const out = join(root, 'sauvegardes');
mkdirSync(user, { recursive: true });

const started: ChildProcess[] = [];
afterAll(() => {
  // Only the children started here, by their pid; one already stopped is fine.
  for (const child of started) {
    if (child.pid === undefined) continue;
    try {
      process.kill(child.pid);
    } catch {
      /* already gone */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function useHome(home: string): void {
  vi.stubEnv('NODALAI_HOME', home);
  vi.stubEnv('USERPROFILE', user);
  vi.stubEnv('HOME', user);
  vi.stubEnv('NODALAI_CONFIG_PATH', undefined);
  vi.resetModules();
}

async function cli(
  home: string,
  args: string[],
): Promise<{ code: number | undefined; output: string }> {
  const run = await execa(
    process.execPath,
    ['--import', 'tsx', join(cliDir, 'src', 'index.ts'), ...args],
    {
      cwd: cliDir,
      env: { NODALAI_HOME: home, USERPROFILE: user, HOME: user, NODALAI_NO_BROWSER: '1' },
      extendEnv: true,
      reject: false,
      timeout: 280_000,
    },
  );
  return { code: run.exitCode, output: `${run.stdout}\n${run.stderr}` };
}

/** Run `fn` against `home`'s database, its cluster started by the CLI's own code and stopped after. */
async function onHomeDatabase<T>(
  home: string,
  fn: (url: string, vector: boolean) => Promise<T>,
): Promise<T> {
  useHome(home);
  const cfg = await import('../lib/config.ts');
  const session = await import('../lib/cluster-session.ts');
  const config = cfg.readConfig();
  if (config === null) throw new Error(`no config in ${home}`);
  return withPostgresClusterStart('cli/backup-restore', () =>
    session.withStartedCluster(config, ({ databaseUrl, vectorAvailable }) =>
      fn(databaseUrl, vectorAvailable),
    ),
  );
}

/** The cluster can start on this machine at all (not on an administrator account under Windows CI). */
const canStart = await (async (): Promise<{ ok: boolean; reason: string }> => {
  const probeDir = join(root, 'probe');
  try {
    const { startEmbeddedPostgres } = await import('../lib/postgres.ts');
    const port = await findFreePort(26090);
    await withPostgresClusterStart('cli/backup-restore:probe', async () => {
      const handle = await startEmbeddedPostgres(
        join(probeDir, 'pg-data'),
        port,
        'probe-password-1234',
        join(probeDir, 'logs'),
      );
      await handle.stop();
    });
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();
if (!canStart.ok)
  console.warn(`
[tests] SKIPPING the CLI backup/restore cases: ${canStart.reason}
`);

/** Home A: an install, the real schema, the local user, a credential encrypted with its key. */
async function installHomeA(): Promise<void> {
  useHome(homeA);
  const cfg = await import('../lib/config.ts');
  const web = await findFreePort(26100);
  const runner = await findFreePort(web + 1);
  const pgPort = await findFreePort(runner + 1);
  cfg.createConfig(cfg.newInstallConfig({ ports: { web, runner, postgres: pgPort } }));
  await onHomeDatabase(homeA, async (url, vector) => {
    const { migrateDatabase } = await import('@nodal-agents/db/safe-migrate');
    const { homeStateFiles } = await import('@nodal-agents/db/snapshots');
    const { seedDefaultUserEntityAgent, LOCAL_USER_ID } = await import('../lib/seed.ts');
    await migrateDatabase(url, {
      patchVectorAsText: !vector,
      repair: false,
      programVersion: '9.9.9',
      keep: 2,
      freeBytes: () => Number.MAX_SAFE_INTEGER,
      stateFiles: homeStateFiles(),
    });
    const { db, close } = createClient(url, { max: 1 });
    try {
      await assertMasterKeyRestorable(db, { keyPath: join(homeA, 'secrets.key') });
      await seedDefaultUserEntityAgent(db, null);
      // Encrypted with the key of this home (the secrets module reads it from NODALAI_HOME).
      const payload = encryptChannelSecret('{"t":"A"}');
      writeFileSync(join(root, 'payload-a.txt'), payload);
      await db
        .insert(credentials)
        .values({ ownerUserId: LOCAL_USER_ID, name: 'Google', type: 'google-oauth', payload });
      await setAppSetting(db, 'probe', 'from home A');
    } finally {
      await close();
    }
  });
}

describe('nodal-agents backup and restore, the real binary @cap:installer-et-demarrer/moteur', () => {
  beforeAll(async () => {
    if (canStart.ok) await installHomeA();
  }, 300_000);

  it.skipIf(!canStart.ok)(
    'backup in one home, restore into a home that holds nothing: the rows, the key, the credential, A settings with B ports and password',
    async () => {
      const made = await cli(homeA, ['backup', '--to', out, '--keep', '3']);
      expect(made.output).toContain('Backup written and verified');
      expect(made.output).toContain('holds the master key');
      expect(made.code).toBe(0);
      const files = readdirSync(out).filter((f) => f.endsWith('.nodalbak'));
      expect(files).toHaveLength(1);

      const configA = JSON.parse(readFileSync(join(homeA, 'config.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
      const restored = await cli(homeB, ['restore', join(out, files[0]!)]);
      expect(restored.output).toContain('No install in this home yet');
      expect(restored.output).toContain(
        'a stored OAuth credential decrypts with the restored master key',
      );
      expect(restored.code).toBe(0);

      // The key is A's.
      expect(readFileSync(join(homeB, 'secrets.key'), 'utf-8')).toBe(
        readFileSync(join(homeA, 'secrets.key'), 'utf-8'),
      );
      // The config: A's settings, B's cluster.
      const configB = JSON.parse(readFileSync(join(homeB, 'config.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(configB['workerSecret']).toBe(configA['workerSecret']);
      expect(configB['authSecret']).toBe(configA['authSecret']);
      expect(configB['postgresPassword']).not.toBe(configA['postgresPassword']);
      expect(existsSync(join(homeB, 'config.json.last-good'))).toBe(true);
      const lastGood = JSON.parse(
        readFileSync(join(homeB, 'config.json.last-good'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(configB['postgresPassword']).toBe(lastGood['postgresPassword']);
      expect(configB['ports']).toEqual(lastGood['ports']);

      // B's cluster, opened with B's own password, holds A's rows.
      await onHomeDatabase(homeB, async (url) => {
        const { db, close } = createClient(url, { max: 1 });
        try {
          expect(await getAppSetting(db, 'probe')).toBe('from home A');
          // The same ciphertext; the restore said it decrypts with B's key file, which is A's.
          const rows = await db.select({ payload: credentials.payload }).from(credentials);
          expect(rows.map((r) => r.payload)).toEqual([
            readFileSync(join(root, 'payload-a.txt'), 'utf-8'),
          ]);
        } finally {
          await close();
        }
      });
    },
    300_000,
  );

  it.skipIf(!canStart.ok)(
    'a backup KILLED mid-way (during the tables, once written, once verified): no file with a backup name, never listed',
    async () => {
      const crashDir = join(root, 'crash');
      for (const step of ['table', 'written', 'verified'] as const) {
        const marker = join(root, `marker-${step}`);
        await onHomeDatabase(homeA, async (url) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              join(cliDir, 'src', 'tests', 'fixtures', 'backup-crash-child.ts'),
              url,
              crashDir,
              step,
              marker,
            ],
            {
              cwd: cliDir,
              env: { ...process.env, NODALAI_HOME: homeA, USERPROFILE: user, HOME: user },
              stdio: 'ignore',
            },
          );
          started.push(child);
          const exited = new Promise<void>((done) => child.once('exit', () => done()));
          await waitForFile(marker, { timeoutMs: 120_000, settled: exited });
          process.kill(child.pid!, 'SIGKILL');
          await exited;
        });
        const left = readdirSync(crashDir);
        expect({ step, named: left.filter((f) => /^nodal-backup-.*\.nodalbak$/.test(f)) }).toEqual({
          step,
          named: [],
        });
        // One: the one this child left; the next child removed the one before (its process was gone).
        expect({ step, partial: left.filter((f) => f.endsWith('.partial')).length }).toEqual({
          step,
          partial: 1,
        });
        const { listBackups } = await import('@nodal-agents/db/backup');
        expect(listBackups(crashDir)).toEqual([]);
      }
      // The next backup removes what the dead ones left, and publishes its own.
      const next = await cli(homeA, ['backup', '--to', crashDir]);
      expect(next.code).toBe(0);
      const after = readdirSync(crashDir);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatch(/^nodal-backup-\d{8}T\d{9}Z\.nodalbak$/);
    },
    300_000,
  );

  it.skipIf(!canStart.ok)(
    'restore while the home runs: refused, and nothing in the home changes',
    async () => {
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      started.push(sleeper);
      mkdirSync(join(homeA, 'pids'), { recursive: true });
      writeFileSync(join(homeA, 'pids', 'processes.json'), JSON.stringify({ runner: sleeper.pid }));
      const configBefore = readFileSync(join(homeA, 'config.json'));
      const keyBefore = readFileSync(join(homeA, 'secrets.key'));
      const files = readdirSync(out).filter((f) => f.endsWith('.nodalbak'));

      const run = await cli(homeA, ['restore', join(out, files[0]!)]);
      expect(run.code).not.toBe(0);
      expect(run.output).toContain(`is running out of this home (runner pid ${sleeper.pid})`);
      expect(run.output).toContain('Nothing was changed');
      expect(readFileSync(join(homeA, 'config.json')).equals(configBefore)).toBe(true);
      expect(readFileSync(join(homeA, 'secrets.key')).equals(keyBefore)).toBe(true);
      expect(existsSync(join(homeA, 'snapshots'))).toBe(false);

      process.kill(sleeper.pid!);
      rmSync(join(homeA, 'pids', 'processes.json'));
    },
    300_000,
  );
});
