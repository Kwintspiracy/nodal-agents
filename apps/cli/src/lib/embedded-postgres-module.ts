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
// The `beforeExit` listener the package adds is therefore removed as soon as
// it is loaded. Nothing else is lost: a postgres the package spawned keeps the
// event loop alive (its stderr is piped and read, never unref'd), so
// `beforeExit` only fires once `gracefulShutdown` has none left to stop; and
// the package's `exit` and signal hooks — which do carry a real code — stay.
//
// Every import of the package goes through `importEmbeddedPostgres`, the test
// harness included (packages/test-kit/src/real-postgres.ts); a direct import
// would bring the hook back, and `architecture.test.ts` refuses one.

import type EmbeddedPostgres from 'embedded-postgres';

export type EmbeddedPostgresCtor = typeof EmbeddedPostgres;

export async function importEmbeddedPostgres(): Promise<EmbeddedPostgresCtor> {
  const before = new Set(process.listeners('beforeExit'));
  const mod = await import('embedded-postgres');
  for (const listener of process.listeners('beforeExit')) {
    if (!before.has(listener)) process.removeListener('beforeExit', listener);
  }
  return mod.default;
}
