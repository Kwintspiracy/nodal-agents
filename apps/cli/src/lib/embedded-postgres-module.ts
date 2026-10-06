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
// The hook's `beforeExit` handler is therefore unhooked after every load,
// through async-exit-hook's own API. It is found by WHAT it is, not by when it
// appeared: a load that happened earlier, by any other path, is undone too.
// Nothing else is lost: a postgres the package spawned keeps the event loop
// alive (its stderr is piped and read, never unref'd), so `beforeExit` only
// fires once `gracefulShutdown` has none left to stop; and the package's
// `exit` and signal hooks — which do carry a real code — stay.
//
// This file is the only one that names the package. Everything that loads it
// — the package itself, its `binary.js`, the test harness in
// packages/test-kit — goes through the functions below, and
// `architecture.test.ts` refuses the name anywhere else.

import { createRequire } from 'node:module';
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
}

/** The package's entry point, as this CLI resolves it. Throws when it is not installed. */
export function resolveEmbeddedPostgresEntry(): string {
  return createRequire(import.meta.url).resolve('embedded-postgres');
}

/**
 * Unhooks async-exit-hook's `beforeExit` handler — the one that turns a natural
 * exit into `process.exit(0)`. The hook is resolved from the package's own
 * directory, so it is the very instance the package registered with. A hook
 * that cannot be found or no longer has this API is an error, never a no-op:
 * the exit code would silently be at the package's mercy again.
 */
function releaseExitCode(entry: string): void {
  let hook: Partial<AsyncExitHook>;
  try {
    hook = createRequire(entry)('async-exit-hook') as Partial<AsyncExitHook>;
  } catch (err) {
    throw new Error(
      `EMBEDDED_POSTGRES_EXIT_HOOK_UNKNOWN: async-exit-hook not found next to ${entry} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof hook.hookedEvents !== 'function' || typeof hook.unhookEvent !== 'function') {
    throw new Error(
      `EMBEDDED_POSTGRES_EXIT_HOOK_UNKNOWN: async-exit-hook next to ${entry} has no hookedEvents/unhookEvent`,
    );
  }
  if (hook.hookedEvents().includes('beforeExit')) hook.unhookEvent('beforeExit');
  if (hook.hookedEvents().includes('beforeExit')) {
    throw new Error(
      `EMBEDDED_POSTGRES_EXIT_HOOK_STUCK: beforeExit still hooked after unhook (${entry})`,
    );
  }
}

export async function importEmbeddedPostgres(): Promise<EmbeddedPostgresCtor> {
  const entry = resolveEmbeddedPostgresEntry();
  const mod = (await import(pathToFileURL(entry).href)) as { default: EmbeddedPostgresCtor };
  releaseExitCode(entry);
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
