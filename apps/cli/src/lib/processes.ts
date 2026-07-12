// processes.ts — spawn runner and web as child processes

import { execa, type ResultPromise } from 'execa';
import { createWriteStream, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'node:url';
import { PID_DIR, LOG_DIR, CONFIG_DIR } from './config.ts';

export type SpawnResult = ResultPromise;

/**
 * Kill a spawned child process and ALL of its descendants.
 *
 * Why this exists: on Windows, spawning .CMD files goes through cmd.exe →
 * node.exe → app. A bare `child.kill('SIGTERM')` only terminates cmd.exe;
 * node.exe (the actual server) survives, keeps the listener port held, and
 * the next `nodal-agents up` fails because :3001 is taken by an orphan.
 *
 * Uses `taskkill /T /F` on Windows to wipe the whole process tree by PID.
 * On Unix-likes the existing SIGTERM-then-SIGKILL escalation works because
 * we don't have the cmd.exe wrapper layer.
 */
export async function killProcessTree(child: ResultPromise): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    try {
      // /T = kill children too. /F = force. We don't care if it failed (the
      // process may already be gone); the next call site already handles
      // unreachable services.
      await execa('taskkill', ['/T', '/F', '/PID', String(pid)], { reject: false });
    } catch {
      /* best-effort */
    }
    return;
  }

  try {
    child.kill('SIGTERM');
    // Give it ~1.5s to flush, then escalate.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  } catch {
    /* already dead */
  }
}

/**
 * Probe whether a PID is currently alive. `process.kill(pid, 0)` sends no
 * signal — it only checks existence, throwing ESRCH when the process is gone.
 * On Windows, EPERM means the process exists but we lack rights to signal it,
 * which still counts as "alive" for our purposes.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Poll until a PID is no longer alive, or the timeout elapses. Returns true
 * if the process died within the window, false if it's still alive at the
 * deadline. Used after a kill to confirm a process (and, for Postgres, its
 * Win32 shared-memory segment) is really gone before we proceed.
 */
export async function waitForPidDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(250);
  }
  return !isPidAlive(pid);
}

/**
 * The CLI runs in two layouts:
 *
 *   1. **Bundled pack** (npm install -g): all artifacts are siblings under
 *      a single dir. `cli.js` + `runner.js` + `web/` + `migrations/` live
 *      next to each other. `BUNDLED_ROOT` resolves to that dir.
 *
 *   2. **Monorepo dev** (tsx): this file lives at `apps/cli/src/lib/processes.ts`
 *      (or `apps/cli/dist/index.js` after a local tsup build). Walk up to
 *      find `pnpm-workspace.yaml` and the apps live as siblings under it.
 *
 * `BUNDLED_ROOT` is the truthy signal — when `<here>/runner.js` exists, we're
 * in the bundled pack and use sibling paths. Otherwise we fall back to the
 * monorepo walk.
 */
const BUNDLED_ROOT: string | null = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return existsSync(join(here, 'runner.js')) ? here : null;
})();

function resolveAppDir(appName: string): string {
  const here = fileURLToPath(import.meta.url);
  const fileDir = dirname(here);

  // Walk up until we hit a dir that contains both `apps/` and a top-level package.json
  // (the monorepo root). Cap the walk to avoid infinite loops.
  let cursor = fileDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cursor, 'pnpm-workspace.yaml'))) {
      return join(cursor, appName);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  // Fallback: assume dev layout (4 dirs up from src/lib)
  return resolve(fileDir, '..', '..', '..', '..', appName);
}

/**
 * Spawn the runner as a child process.
 *
 * - Bundled mode: `node <pack>/runner.js` (single-file esbuild bundle).
 * - Dev mode: `tsx apps/runner/src/server.ts` from the monorepo. tsx is in
 *   apps/runner's devDeps. On Windows we resolve the .CMD wrapper
 *   explicitly because Node's spawn doesn't auto-add the .CMD extension.
 */
export function spawnRunner(env: Record<string, string>): ResultPromise {
  const logFile = join(LOG_DIR, 'runner.log');
  const outStream = createWriteStream(logFile, { flags: 'a' });

  let bin: string;
  let args: string[];
  let cwd: string;

  if (BUNDLED_ROOT) {
    bin = process.execPath; // current node binary
    args = [join(BUNDLED_ROOT, 'runner.js')];
    cwd = BUNDLED_ROOT;
  } else {
    const runnerDir = resolveAppDir('apps/runner');
    bin = resolveLocalBin(runnerDir, 'tsx');
    args = ['src/server.ts'];
    cwd = runnerDir;
  }

  outStream.write(
    `\n--- spawnRunner ${new Date().toISOString()} ---\n` +
      `mode: ${BUNDLED_ROOT ? 'bundled' : 'dev'}\n` +
      `cwd: ${cwd}\n` +
      `bin: ${bin}\n` +
      `env keys: ${Object.keys(env).join(',')}\n\n`,
  );

  const child = execa(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
    // Only need a shell wrapper to invoke the .CMD tsx launcher on Windows.
    // process.execPath is the literal node binary, no shell needed.
    shell: !BUNDLED_ROOT && process.platform === 'win32',
  });

  child.stdout?.pipe(outStream);
  child.stderr?.pipe(outStream);

  return child;
}

export interface SpawnWebOptions {
  /**
   * When true, spawn `next dev` (HMR enabled, no build required).
   * When false (default), spawn `next start` against a prebuilt `.next/` dir.
   *
   * Dev mode is the right choice for active migration work: edits to web
   * source reload in the browser without rebuilding. Start mode is a couple
   * hundred ms faster on response and matches what we'd ship.
   */
  dev?: boolean;
}

/**
 * Spawn the web (Next.js) as a child process.
 *
 * - Bundled mode: `node <pack>/web/server.js` — the Next standalone server.
 *   `--dev` is ignored because the standalone build is prod-only (no HMR
 *   available without the source tree).
 * - Dev mode: `next dev` or `next start` from apps/web/.
 */
export function spawnWeb(env: Record<string, string>, opts: SpawnWebOptions = {}): ResultPromise {
  const logFile = join(LOG_DIR, 'web.log');
  const outStream = createWriteStream(logFile, { flags: 'a' });

  let bin: string;
  let args: string[];
  let cwd: string;
  let modeLabel: string;

  if (BUNDLED_ROOT) {
    bin = process.execPath;
    args = [join(BUNDLED_ROOT, 'web', 'server.js')];
    cwd = join(BUNDLED_ROOT, 'web');
    modeLabel = 'bundled-standalone';
  } else {
    const webDir = resolveAppDir('apps/web');
    bin = resolveLocalBin(webDir, 'next');
    // `next dev` runs Turbopack (Next 16 default). It handles workspace
    // .js → .ts resolution natively for transpiled packages, so the webpack()
    // hook in next.config.ts (used only by `next build --webpack`) is a no-op
    // in dev mode. Forcing --webpack in dev triggers a regression in Next 16
    // where next-flight-css-loader no longer chains PostCSS, which breaks
    // tailwind imports. Keeping Turbopack for dev and webpack for prod build
    // is the canonical Next 16 setup.
    const subcommand = opts.dev ? 'dev' : 'start';
    args = [subcommand];
    cwd = webDir;
    modeLabel = subcommand;
  }

  outStream.write(
    `\n--- spawnWeb ${new Date().toISOString()} ---\n` +
      `cwd: ${cwd}\n` +
      `bin: ${bin}\n` +
      `mode: ${modeLabel}\n` +
      `env keys: ${Object.keys(env).join(',')}\n\n`,
  );

  const child = execa(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
    shell: !BUNDLED_ROOT && process.platform === 'win32',
  });

  child.stdout?.pipe(outStream);
  child.stderr?.pipe(outStream);

  return child;
}

/**
 * Resolve the path to a local node_modules/.bin entry, picking the .CMD
 * wrapper on Windows so Node's spawn can find and execute it directly.
 */
function resolveLocalBin(packageDir: string, binName: string): string {
  const ext = process.platform === 'win32' ? '.CMD' : '';
  return join(packageDir, 'node_modules', '.bin', `${binName}${ext}`);
}

// ─── PID file helpers ─────────────────────────────────────────────────────────

export interface PidFile {
  runner?: number;
  web?: number;
}

export function writePids(pids: PidFile): void {
  writeFileSync(join(PID_DIR, 'processes.json'), JSON.stringify(pids, null, 2), 'utf-8');
}

export function readPids(): PidFile | null {
  const pidFile = join(PID_DIR, 'processes.json');
  if (!existsSync(pidFile)) return null;
  try {
    return JSON.parse(readFileSync(pidFile, 'utf-8')) as PidFile;
  } catch {
    return null;
  }
}

export function clearPids(): void {
  const pidFile = join(PID_DIR, 'processes.json');
  if (existsSync(pidFile)) {
    writeFileSync(pidFile, JSON.stringify({}), 'utf-8');
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────

/**
 * Wait until a service's /api/health endpoint returns 200.
 * Polls every 500ms, times out after timeoutMs.
 */
export async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${url}/api/health`, { signal: controller.signal });
      clearTimeout(t);
      if (res.status === 200) return;
    } catch {
      // Not ready yet
    }
    await sleep(500);
  }
  throw new Error(`Service at ${url} did not become healthy within ${timeoutMs}ms`);
}

/**
 * Prove the web app actually RENDERS, not just that it answers /api/health.
 * That endpoint is a trivial route: it stays 200 even when every (dashboard)
 * page 500s — e.g. when a runtime dependency of the standalone build is
 * missing from the pack's package.json (caught live on the 0.7.8 ritual:
 * discord.js absent → MODULE_NOT_FOUND on every dashboard route, CLI still
 * printed "All services healthy"). GET / follows redirects (login/onboarding
 * are fine landings); anything 5xx after the deadline is a hard failure.
 */
export async function assertWebRenders(url: string, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      // Per-attempt budget must survive `next dev`'s cold Turbopack compile of
      // the dashboard: the FIRST GET / hangs (no response at all) until the
      // compile finishes — sometimes minutes on a cold cache. A short abort
      // made every attempt "unreachable" and tore the dev stack down at boot
      // (live incident, 2026-07-12, right after this probe shipped). The
      // packed build renders in milliseconds and is unaffected.
      const t = setTimeout(() => controller.abort(), 60_000);
      const res = await fetch(`${url}/`, { signal: controller.signal });
      clearTimeout(t);
      lastStatus = res.status;
      if (res.status < 500) return;
    } catch {
      // Not ready yet
    }
    await sleep(1000);
  }
  throw new Error(
    `Web responds on /api/health but page render fails (HTTP ${lastStatus || 'unreachable'}). ` +
      'Check the web log (~/.nodalai/logs/web.log) for the underlying error.',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { CONFIG_DIR };
