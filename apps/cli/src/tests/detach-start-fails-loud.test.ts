// detach-start-fails-loud.test.ts — a detached start that did not go through the
// detached spawn is an ERROR, not a cluster that dies later (#835, review pass 1).
//
// `embedded-postgres` is a caret-ranged beta in spirit (now pinned): a version
// that destructures `spawn` at load, spells the binary path differently, or
// starts postgres through `execFile`/`pg_ctl` would never reach the arm in
// `startEmbeddedPostgres`, and `up --detach` would be broken again with nothing
// said — the real-cluster cases skip on the Windows CI runner. So the start
// itself checks that the arm fired, before anything reports healthy.
//
// The package is a stand-in here (its `start()` is the only thing that matters:
// does it spawn the postgres binary, and through `child_process.spawn`), and a
// spy sits under `child_process.spawn`, so nothing real is started on any
// platform and the cases run everywhere.

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ onStart: null as null | (() => void) }));

vi.mock('../lib/embedded-postgres-module.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/embedded-postgres-module.ts')>();
  class FakeEmbeddedPostgres {
    constructor(readonly options: unknown) {}
    async initialise(): Promise<void> {}
    async start(): Promise<void> {
      fake.onStart?.();
    }
    async stop(): Promise<void> {}
    async createDatabase(): Promise<void> {}
    getPgClient() {
      return { connect: async () => {}, end: async () => {}, query: async () => ({ rows: [] }) };
    }
  }
  return {
    ...original,
    importEmbeddedPostgres: async () => FakeEmbeddedPostgres as never,
  };
});

import { importEmbeddedPostgresBinaries } from '../lib/embedded-postgres-module.ts';
import { startEmbeddedPostgres } from '../lib/postgres.ts';

const childProcess = createRequire(import.meta.url)('node:child_process') as {
  spawn: (...args: unknown[]) => unknown;
};
const realSpawn = childProcess.spawn;

const root = mkdtempSync(join(tmpdir(), 'nodal-detach-loud-'));
const dataDir = join(root, 'pg-data');
const logDir = join(root, 'logs');

let seen: Array<{ file: unknown; detached: unknown }>;
let postgres: string;

beforeEach(async () => {
  mkdirSync(dataDir, { recursive: true });
  // An initialised cluster, so the stand-in is not asked to run initdb.
  writeFileSync(join(dataDir, 'PG_VERSION'), '18\n', 'utf-8');
  seen = [];
  // The spy sits UNDER the arm: it records what a spawn was finally called with.
  childProcess.spawn = (...args: unknown[]) => {
    const options = (Array.isArray(args[1]) ? args[2] : args[1]) as
      | { detached?: unknown }
      | undefined;
    seen.push({ file: args[0], detached: options?.detached });
    return {};
  };
  syncBuiltinESMExports();
  const binaries = await importEmbeddedPostgresBinaries();
  postgres = binaries!.postgres as string;
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
});

afterEach(() => {
  childProcess.spawn = realSpawn;
  syncBuiltinESMExports();
  fake.onStart = null;
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a detached start checks its own spawn @cap:installer-et-demarrer/moteur', () => {
  it('arms the spawn: the package spawning postgres through child_process.spawn gets it detached', async () => {
    fake.onStart = () => {
      childProcess.spawn(postgres, ['-D', dataDir], { stdio: 'pipe' });
    };

    const handle = await startEmbeddedPostgres(dataDir, 25999, 'pw', logDir, { detached: true });

    expect(seen).toEqual([{ file: postgres, detached: true }]);
    expect(typeof handle.outliveLauncher).toBe('function');
  });

  it('a package that never goes through the detached spawn makes the start FAIL, named, before it reports healthy', async () => {
    // The drifted shape: start() resolves, postgres was spawned some other way.
    fake.onStart = () => {};

    await expect(
      startEmbeddedPostgres(dataDir, 25999, 'pw', logDir, { detached: true }),
    ).rejects.toThrow(/EMBEDDED_POSTGRES_SPAWN_NOT_DETACHED/);

    // And the arm did not stay behind: the original spawn is back in place.
    childProcess.spawn(postgres, ['-D', dataDir], {});
    expect(seen.at(-1)).toEqual({ file: postgres, detached: undefined });
  });

  it('a foreground start arms nothing and asks nothing of the spawn', async () => {
    fake.onStart = () => {
      childProcess.spawn(postgres, ['-D', dataDir], { stdio: 'pipe' });
    };

    await startEmbeddedPostgres(dataDir, 25999, 'pw', logDir);

    expect(seen).toEqual([{ file: postgres, detached: undefined }]);
  });

  it('a foreground start does not require the spawn to have been seen', async () => {
    fake.onStart = () => {};

    await expect(startEmbeddedPostgres(dataDir, 25999, 'pw', logDir)).resolves.toBeDefined();
  });
});
