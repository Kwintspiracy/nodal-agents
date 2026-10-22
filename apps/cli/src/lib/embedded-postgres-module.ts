// embedded-postgres-module.ts — the ONE way any Nodal process loads `embedded-postgres`.
//
// `embedded-postgres@18.3.0-beta.17` registers `async-exit-hook` the moment its
// module is evaluated (`dist/index.js`: `AsyncExitHook(gracefulShutdown)`), and
// that hook listens to `beforeExit` and answers it with `process.exit(0)`. An
// explicit code wins over `process.exitCode`, so ANY process that merely loads
// the package and then ends naturally exits 0, whatever it had decided.
//
// Vitest is exactly such a process: a failing run sets `process.exitCode = 1`
// and lets the event loop drain. The `pg` project's `globalSetup` loads the
// package in vitest's MAIN process, so every run holding a `*.pg.test.ts` file
// reported its failures and exited 0 — turbo counted the task successful and
// the Linux CI went green on a red test (run 37429428426, issue #698). Windows
// CI has no `pg` project, never loaded the package, and went red as it should.
//
// The hook's `beforeExit` handler is therefore REPLACED after every load,
// through async-exit-hook's own API. It is found by WHAT it is, not by when it
// appeared: a load that happened earlier, by any other path, is undone too.
// The replacement does exactly what the original did — run the package's
// `gracefulShutdown` to completion, then exit — with the code the process had
// decided instead of 0. Unhooking without replacing is not enough: the
// package's `exit` handler then becomes the first to run, calls
// `gracefulShutdown` without its callback, and the process dies on
// `TypeError: done is not a function` (seen in pack-smoke, run 37433850617).
// The signal hooks, which carry a real code, stay as they are.
//
// This file is the only one that names the package. Everything that loads it
// — the package itself, its `binary.js`, the test harness in
// packages/test-kit — goes through the functions below, and
// `architecture.test.ts` refuses the name anywhere else.

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type EmbeddedPostgres from 'embedded-postgres';

export type EmbeddedPostgresCtor = typeof EmbeddedPostgres;

/** What `binary.js` hands back: absolute paths, checked by each caller. */
export type EmbeddedPostgresBinaries = Partial<Record<'pg_ctl' | 'initdb' | 'postgres', unknown>>;

/** The surface of `async-exit-hook@2.0.1` used here. */
interface AsyncExitHook {
  hookedEvents(): string[];
  unhookEvent(event: string): void;
  /** Runs every registered hook, then `process.exit(code)`, when `event` is emitted. */
  hookEvent(event: string, code: number): void;
}

/**
 * The event our `beforeExit` replacement emits to run the package's shutdown
 * with the process's own code. Hooked once, at the first natural exit, since
 * async-exit-hook binds a code when the event is hooked.
 */
const NATURAL_EXIT = 'nodal-agents:embedded-postgres-natural-exit';

/**
 * Marks the hook instance as already given its replacement. A process-wide
 * symbol on the hook itself, because this file can be evaluated more than once
 * in one process (the CLI bundle, or vitest's module graph next to Node's).
 */
const REPLACED = Symbol.for('nodal-agents.embedded-postgres.before-exit-replaced');

/**
 * Set once the clusters have been released from the exit hook (see
 * `releaseEmbeddedPostgresFromExit`). The natural-exit replacement checks it so
 * that a `beforeExit` after the release cannot put the shutdown back.
 */
let released = false;

/** The package's entry point, as this CLI resolves it. Throws when it is not installed. */
export function resolveEmbeddedPostgresEntry(): string {
  return createRequire(import.meta.url).resolve('embedded-postgres');
}

/**
 * Replaces async-exit-hook's `beforeExit` handler — the one that turns a
 * natural exit into `process.exit(0)` — by one that exits with the process's
 * own code. The hook is resolved from the package's own directory, so it is
 * the very instance the package registered with. A hook that cannot be found
 * or no longer has this API is an error, never a no-op: the exit code would
 * silently be at the package's mercy again.
 */
function keepExitCode(entry: string): void {
  let loaded: unknown;
  try {
    loaded = createRequire(entry)('async-exit-hook');
  } catch (err) {
    throw new Error(
      `EMBEDDED_POSTGRES_EXIT_HOOK_UNKNOWN: async-exit-hook not found next to ${entry} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const candidate = loaded as Partial<AsyncExitHook> & { [REPLACED]?: true };
  if (
    typeof candidate.hookedEvents !== 'function' ||
    typeof candidate.unhookEvent !== 'function' ||
    typeof candidate.hookEvent !== 'function'
  ) {
    throw new Error(
      `EMBEDDED_POSTGRES_EXIT_HOOK_UNKNOWN: async-exit-hook next to ${entry} has no hookedEvents/unhookEvent/hookEvent`,
    );
  }
  const hook = candidate as AsyncExitHook & { [REPLACED]?: true };
  if (hook.hookedEvents().includes('beforeExit')) hook.unhookEvent('beforeExit');
  if (hook.hookedEvents().includes('beforeExit')) {
    throw new Error(
      `EMBEDDED_POSTGRES_EXIT_HOOK_STUCK: beforeExit still hooked after unhook (${entry})`,
    );
  }
  if (hook[REPLACED]) return;
  hook[REPLACED] = true;
  // Node hands `beforeExit` listeners the exit code the process is heading for.
  process.on('beforeExit', (code: number) => {
    if (released) return;
    if (hook.hookedEvents().includes(NATURAL_EXIT)) return;
    hook.hookEvent(NATURAL_EXIT, code);
    (process as NodeJS.EventEmitter).emit(NATURAL_EXIT, code);
  });
}

/**
 * Let every cluster this process started OUTLIVE it.
 *
 * `embedded-postgres` stops all its clusters when the process exits: its
 * `gracefulShutdown` hangs on `exit`, `beforeExit`, the signals and the PM2
 * `message`, and on Windows answers with `taskkill /pid <postgres> /f /t`. That
 * is right for a foreground `up`, whose Ctrl+C must stop everything, and wrong
 * for `up --detach`: the cluster is a CHILD of the launcher (the package
 * `spawn`s `postgres -D …` itself — it is not a pg_ctl daemon), so the launcher's
 * own `process.exit(0)` killed the database it had just reported healthy while
 * the runner and the web, detached, went on running against nothing (#835).
 *
 * Releasing is unhooking every event the package hooked, through
 * async-exit-hook's own API, resolved from the package's directory so it is the
 * very instance the package registered with. The cluster keeps running after
 * the launcher is gone, and `nodal-agents down` stops it by its data directory.
 *
 * A one-way gesture for the rest of THIS process's life, which is a few
 * milliseconds long: the caller exits right after. Not loading the package, or
 * a hook with nothing hooked, is a no-op; a hook that cannot be reached is an
 * error, never a silent "released" over a cluster that will still be killed.
 */
export function releaseEmbeddedPostgresFromExit(): void {
  if (released) return;
  const entry = resolveEmbeddedPostgresEntry();
  let loaded: unknown;
  try {
    loaded = createRequire(entry)('async-exit-hook');
  } catch (err) {
    throw new Error(
      `EMBEDDED_POSTGRES_EXIT_HOOK_UNKNOWN: async-exit-hook not found next to ${entry} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const hook = loaded as Partial<AsyncExitHook>;
  if (typeof hook.hookedEvents !== 'function' || typeof hook.unhookEvent !== 'function') {
    throw new Error(
      `EMBEDDED_POSTGRES_EXIT_HOOK_UNKNOWN: async-exit-hook next to ${entry} has no hookedEvents/unhookEvent`,
    );
  }
  releaseExitHook(hook as AsyncExitHook, entry);
  released = true;
}

/**
 * The release itself, on a hook object: separate so that its failures can be
 * exercised without a process that has (or has not) loaded the package.
 *
 * Two shapes are errors, and the second is the one that matters: events still
 * hooked afterwards (the stop-at-exit is still there), and NOTHING hooked to
 * begin with — a package that has changed how it registers its exit handling
 * would otherwise be "released" over a cluster that is still going to be killed,
 * with the success of a no-op (the pinned version hooks seven events; zero means
 * the shape is not the one this was written against).
 */
export function releaseExitHook(
  hook: Pick<AsyncExitHook, 'hookedEvents' | 'unhookEvent'>,
  entry: string,
): void {
  const events = hook.hookedEvents();
  if (events.length === 0) {
    throw new Error(
      `EMBEDDED_POSTGRES_EXIT_HOOK_UNKNOWN: nothing is hooked by async-exit-hook next to ${entry}, ` +
        'so the package no longer stops its clusters the way this release was written against',
    );
  }
  for (const event of events) hook.unhookEvent(event);
  const left = hook.hookedEvents();
  if (left.length > 0) {
    throw new Error(
      `EMBEDDED_POSTGRES_EXIT_HOOK_STUCK: ${left.join(', ')} still hooked after release (${entry})`,
    );
  }
}

/**
 * Make the NEXT spawn of the postgres binary a DETACHED one, so the cluster does
 * not die with the process that starts it. Returns the function that disarms it.
 *
 * Releasing the exit hook (above) is half of it. The other half is the OS: on
 * Windows libuv puts every child it spawns into a job object that is killed
 * when the parent goes (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), unless the spawn
 * is `detached`. A cluster spawned the package's way is therefore killed by the
 * operating system the moment the launcher exits, hook or no hook (measured
 * here: released hook, postmaster dead at the launcher's `process.exit`). A
 * detached child also has no console (closing the terminal sends CTRL_CLOSE to
 * every attached process, postgres included) and, on Unix, leads its own
 * session (no SIGHUP, no Ctrl+C from the terminal).
 *
 * The package does not expose `spawn`'s options, so the one call that starts the
 * postmaster is recognised by WHAT it runs — the bundled postgres binary — and
 * given `detached: true`; every other spawn in the process, before and after,
 * is untouched. One-shot: it restores itself at that spawn, and `disarm` does
 * the same when no spawn came. `matched()` says whether the spawn was seen. `child_process` is patched on the CJS object and
 * the ESM named exports are re-synced, which is how the package's
 * `import { spawn }` sees it.
 */
export interface DetachedSpawnArm {
  /** Put the original `spawn` back (a no-op once the arm has fired). */
  disarm: () => void;
  /**
   * Did the arm fire — was the postgres binary actually spawned detached? The
   * caller MUST check it once the start has returned: a package whose spawn
   * shape has drifted (destructured at load, another spelling of the path, an
   * `execFile`) never reaches the wrapper, and the cluster would start attached
   * and die with the launcher with nothing said (#835).
   */
  matched: () => boolean;
}

export async function armDetachedPostgresSpawn(): Promise<DetachedSpawnArm> {
  const binaries = await importEmbeddedPostgresBinaries();
  const postgres = binaries?.postgres;
  if (typeof postgres !== 'string') {
    throw new Error(
      'EMBEDDED_POSTGRES_BINARY_UNKNOWN: the package gave no postgres binary path, so the ' +
        'cluster cannot be started detached',
    );
  }
  const cp = createRequire(import.meta.url)('node:child_process') as {
    spawn: (...args: unknown[]) => unknown;
  };
  const original = cp.spawn;
  let matched = false;
  const restore = (): void => {
    if (cp.spawn === wrapper) {
      cp.spawn = original;
      syncBuiltinESMExports();
    }
  };
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    if (args[0] !== postgres) return original.apply(this, args);
    matched = true;
    restore();
    // spawn(file, args?, options?): the options are the first non-array object
    // after the file, or are absent.
    const at = Array.isArray(args[1]) ? 2 : 1;
    const given = (args[at] ?? {}) as Record<string, unknown>;
    const next = [...args];
    next[at] = { ...given, detached: true };
    return original.apply(this, next);
  };
  cp.spawn = wrapper;
  syncBuiltinESMExports();
  return { disarm: restore, matched: () => matched };
}

export async function importEmbeddedPostgres(): Promise<EmbeddedPostgresCtor> {
  const entry = resolveEmbeddedPostgresEntry();
  const mod = (await import(pathToFileURL(entry).href)) as { default: EmbeddedPostgresCtor };
  keepExitCode(entry);
  return mod.default;
}

/**
 * The binaries of the platform package, as the package's own `binary.js` finds
 * them. `embedded-postgres` exports only `./dist/index.js`, so `binary.js` is
 * loaded by PATH, next to the entry point; it picks the right
 * `@embedded-postgres/<platform>` from ITS position — the only place pnpm makes
 * that optional dependency reachable. It does not evaluate `index.js`.
 */
export async function importEmbeddedPostgresBinaries(): Promise<
  EmbeddedPostgresBinaries | undefined
> {
  const entry = resolveEmbeddedPostgresEntry();
  const mod = (await import(pathToFileURL(join(dirname(entry), 'binary.js')).href)) as {
    default?: () => Promise<EmbeddedPostgresBinaries>;
  };
  return mod.default?.();
}
