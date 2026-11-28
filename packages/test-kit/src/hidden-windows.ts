// hidden-windows.ts — no process a test starts opens a window on Windows.
//
// Under Windows, a console program started by a process that has no console
// of its own (the agent's shell, an IDE, a scheduled run) gets a new console
// window, shown until it ends; `detached: true` gives it one in every case.
// A test run starts hundreds of them (the embedded database, the CLI, git, a
// shell, the vitest workers), and each one flashed on the screen of the person
// at the machine. Something a test makes appear there is a defect.
//
// The one mechanism: in every test process (the vitest main process, where the
// config and the global setups run, and each worker, through the setup file),
// the functions of `node:child_process` that start a process default
// `windowsHide` to true. A call that sets `windowsHide` itself keeps its value.
// The ESM named exports are re-synced, which is how a module's
// `import { spawn } from 'node:child_process'` sees it (the same technique as
// `armDetachedPostgresSpawn`, apps/cli/src/lib/embedded-postgres-module.ts).
//
// It changes nothing outside a test process: what the product starts at run
// time is the product's own concern, and is said where it is decided.

import { createRequire, syncBuiltinESMExports } from 'node:module';

type Starter = 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync' | 'fork' | 'exec' | 'execSync';

const STARTERS: readonly Starter[] = [
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'fork',
  'exec',
  'execSync',
];

const isOptions = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The arguments of one call of `starter`, with `windowsHide: true` in its
 * options unless the call set `windowsHide` itself. Pure: the caller's objects
 * are never changed, a copy carries the option.
 */
export function withHiddenWindow(starter: Starter, args: readonly unknown[]): unknown[] {
  const out = [...args];
  // Where the options go: after the command for `exec`, after the arguments
  // list (when there is one) for the others.
  const at = starter === 'exec' || starter === 'execSync' ? 1 : Array.isArray(out[1]) ? 2 : 1;
  const given = out[at];
  if (isOptions(given)) {
    if (!('windowsHide' in given)) out[at] = { ...given, windowsHide: true };
    return out;
  }
  if (given === undefined || given === null) {
    out[at] = { windowsHide: true };
    return out;
  }
  if (typeof given === 'function') {
    // A callback where the options would be: the options go before it.
    out.splice(at, 0, { windowsHide: true });
    return out;
  }
  return out;
}

const INSTALLED = Symbol.for('nodal.test-kit.hidden-windows');

/**
 * Make every process this process starts default to a hidden window, on
 * Windows. Idempotent; a no-op on other systems, where the option means
 * nothing.
 */
export function hideTestWindows(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const cp = createRequire(import.meta.url)('node:child_process') as Record<
    Starter,
    ((...args: unknown[]) => unknown) & { [INSTALLED]?: true }
  >;
  if (cp.spawn[INSTALLED]) return true;
  for (const name of STARTERS) {
    const original = cp[name];
    const wrapper = Object.assign(
      function (this: unknown, ...args: unknown[]): unknown {
        return original.apply(this, withHiddenWindow(name, args));
      },
      { [INSTALLED]: true as const },
    );
    // `exec` and `execFile` have promisified forms Node reads from them.
    for (const key of Object.getOwnPropertySymbols(original)) {
      (wrapper as unknown as Record<symbol, unknown>)[key] = (
        original as unknown as Record<symbol, unknown>
      )[key];
    }
    cp[name] = wrapper;
  }
  syncBuiltinESMExports();
  return true;
}
