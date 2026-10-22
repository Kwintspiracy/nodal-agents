// detach-keeps-postgres.test.ts — the two halves of keeping the cluster alive
// after `up --detach` exits (#835), proven on their own and on every platform.
//
// The real thing — a cluster surviving a launcher — is in
// detach-keeps-postgres.pg.test.ts. What it cannot show everywhere is each half
// alone, because they hide each other: on Windows the exit hook's `taskkill` is
// itself killed with the dying launcher (so a missing release looks harmless
// there), and off Windows there is no job object (so a missing detachment looks
// harmless there). Each half is therefore pinned by what it DOES to the process:
//
//   · releasing unhooks every event `embedded-postgres` hooked;
//   · arming makes the next spawn of the postgres binary — and only that one —
//     a detached spawn.

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  armDetachedPostgresSpawn,
  importEmbeddedPostgres,
  importEmbeddedPostgresBinaries,
  releaseEmbeddedPostgresFromExit,
  resolveEmbeddedPostgresEntry,
} from '../lib/embedded-postgres-module.ts';

interface ExitHook {
  hookedEvents(): string[];
}

const childProcess = createRequire(import.meta.url)('node:child_process') as {
  spawn: (...args: unknown[]) => unknown;
};
const realSpawn = childProcess.spawn;

afterEach(() => {
  childProcess.spawn = realSpawn;
  syncBuiltinESMExports();
});

describe('releasing the cluster from the package exit hook @cap:installer-et-demarrer/moteur', () => {
  it('unhooks every event the package hooked, and removes the listeners from the process', async () => {
    await importEmbeddedPostgres();
    const hook = createRequire(resolveEmbeddedPostgresEntry())('async-exit-hook') as ExitHook;
    const before = hook.hookedEvents();
    // The package really did hook the exit paths.
    expect(before).toEqual(expect.arrayContaining(['exit', 'SIGINT', 'SIGTERM']));
    const listenersBefore = Object.fromEntries(
      before.map((event) => [event, process.listenerCount(event)]),
    );

    releaseEmbeddedPostgresFromExit();

    expect(hook.hookedEvents()).toEqual([]);
    for (const event of before) {
      // One listener fewer for each event: ours is not the only one on it.
      expect(process.listenerCount(event)).toBe(listenersBefore[event]! - 1);
    }
  });

  it('is idempotent: a second release is a no-op, not an error', () => {
    releaseEmbeddedPostgresFromExit();
    expect(() => releaseEmbeddedPostgresFromExit()).not.toThrow();
  });
});

describe('arming a detached postgres spawn @cap:installer-et-demarrer/moteur', () => {
  /** A spy under the patch: records what each spawn was finally called with. */
  function spyOnSpawn(): Array<{ file: unknown; options: Record<string, unknown> | undefined }> {
    const seen: Array<{ file: unknown; options: Record<string, unknown> | undefined }> = [];
    childProcess.spawn = (...args: unknown[]) => {
      const options = (Array.isArray(args[1]) ? args[2] : args[1]) as
        | Record<string, unknown>
        | undefined;
      seen.push({ file: args[0], options });
      return {};
    };
    syncBuiltinESMExports();
    return seen;
  }

  async function postgresBinary(): Promise<string> {
    const binaries = await importEmbeddedPostgresBinaries();
    expect(typeof binaries?.postgres).toBe('string');
    return binaries!.postgres as string;
  }

  it('the next spawn of the postgres binary is detached, with its other options kept', async () => {
    const seen = spyOnSpawn();
    const postgres = await postgresBinary();

    await armDetachedPostgresSpawn();
    childProcess.spawn(postgres, ['-D', 'somewhere'], { env: { A: '1' }, stdio: 'pipe' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.file).toBe(postgres);
    expect(seen[0]!.options).toEqual({ env: { A: '1' }, stdio: 'pipe', detached: true });
  });

  it('only that spawn: others, before and after, are untouched; and it is one-shot', async () => {
    const seen = spyOnSpawn();
    const postgres = await postgresBinary();

    await armDetachedPostgresSpawn();
    childProcess.spawn('something-else', ['x'], { stdio: 'ignore' });
    childProcess.spawn(postgres, ['-D', 'a'], {});
    childProcess.spawn(postgres, ['-D', 'b'], {});
    childProcess.spawn('and-after', [], {});

    expect(seen.map((s) => s.options?.['detached'])).toEqual([
      undefined,
      true,
      undefined,
      undefined,
    ]);
  });

  it('disarming before any spawn puts the original back and detaches nothing', async () => {
    const seen = spyOnSpawn();
    const spy = childProcess.spawn;
    const postgres = await postgresBinary();

    const disarm = await armDetachedPostgresSpawn();
    expect(childProcess.spawn).not.toBe(spy);
    disarm();

    expect(childProcess.spawn).toBe(spy);
    childProcess.spawn(postgres, ['-D', 'a'], {});
    expect(seen[0]!.options?.['detached']).toBeUndefined();
  });
});

describe('up wires both halves, and only on --detach @cap:installer-et-demarrer/moteur', () => {
  // Structural, said as such: `up` boots a database, a runner and a web and
  // cannot run in a unit test. What this pins is the wiring; the behaviour
  // behind it is proven above and in detach-keeps-postgres.pg.test.ts.
  const up = readFileSync(fileURLToPath(new URL('../commands/up.ts', import.meta.url)), 'utf-8');

  it('the cluster is started detached only when --detach is asked for', () => {
    expect(up).toMatch(
      /startEmbeddedPostgres\([^)]*\{\s*detached:\s*opts\.detach === true,?\s*\}/s,
    );
  });

  it('the detached branch releases the cluster right before it exits', () => {
    const branch = up.slice(up.indexOf('if (opts.detach) {'));
    const release = branch.indexOf('pg.outliveLauncher()');
    const exit = branch.indexOf('process.exit(0)');
    expect(release).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(release);
  });

  it('the foreground shutdown still stops the cluster itself', () => {
    expect(up).toMatch(/await pg\.stop\(\);\s*clearPids\(\);/);
  });
});
