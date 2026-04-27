// processes.ts — spawn runner and web as child processes

import { execa, type ResultPromise } from 'execa';
import { createWriteStream, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PID_DIR, LOG_DIR, CONFIG_DIR } from './config.ts';

export type SpawnResult = ResultPromise;

/**
 * Resolve the path to the apps/runner directory relative to this CLI package.
 * In dist/ or dev, the CLI lives at apps/cli/dist/ or apps/cli/src/,
 * so apps/runner is always 2 levels up + runner.
 */
function resolveAppDir(appName: string): string {
  const cliRoot = join(new URL(import.meta.url).pathname.replace(/\\/g, '/'), '../../../..');
  const normalized =
    process.platform === 'win32' ? cliRoot.replace(/^\/([A-Za-z]:)/, '$1') : cliRoot;
  return join(normalized, appName);
}

/**
 * Spawn the runner (apps/runner) as a child process.
 */
export function spawnRunner(env: Record<string, string>): ResultPromise {
  const runnerDir = resolveAppDir('apps/runner');
  const logFile = join(LOG_DIR, 'runner.log');
  const outStream = createWriteStream(logFile, { flags: 'a' });

  const child = execa('node', ['dist/server.js'], {
    cwd: runnerDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
  });

  child.stdout?.pipe(outStream);
  child.stderr?.pipe(outStream);

  return child;
}

/**
 * Spawn the web (apps/web — Next.js) as a child process.
 */
export function spawnWeb(env: Record<string, string>): ResultPromise {
  const webDir = resolveAppDir('apps/web');
  const logFile = join(LOG_DIR, 'web.log');
  const outStream = createWriteStream(logFile, { flags: 'a' });

  const child = execa('node', ['.next/standalone/server.js'], {
    cwd: webDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
  });

  child.stdout?.pipe(outStream);
  child.stderr?.pipe(outStream);

  return child;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { CONFIG_DIR };
