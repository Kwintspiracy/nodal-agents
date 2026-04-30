// up.ts — start everything: postgres, migrations, seed, runner, web, then open browser

import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { readConfig } from '../lib/config.ts';
import { runInit } from './init.ts';
import { startEmbeddedPostgres, runMigrations } from '../lib/postgres.ts';
import { seedDefaultUserEntityAgent } from '../lib/seed.ts';
import { buildEnvForRunner, buildEnvForWeb, buildDatabaseUrl } from '../lib/env.ts';
import {
  spawnRunner,
  spawnWeb,
  waitForHealth,
  writePids,
  clearPids,
  type SpawnResult,
} from '../lib/processes.ts';
import { createClient } from '@nodalai/db';

function killSilent(child: SpawnResult): void {
  try {
    child.kill('SIGTERM');
  } catch {
    /* already dead */
  }
}

/**
 * Returns the PID of a process listening on the given port, or null if free.
 * Windows-aware (uses netstat). Returns null on Unix (where we'd use lsof,
 * but the user's environment is Windows for now).
 */
async function pidListeningOnPort(port: number): Promise<number | null> {
  const { execa } = await import('execa');
  try {
    const { stdout } = await execa('netstat', ['-ano'], { reject: false });
    for (const line of stdout.split(/\r?\n/)) {
      // "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       14568"
      const m = line.match(/\s+TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && m[1] && m[2] && Number.parseInt(m[1], 10) === port) {
        return Number.parseInt(m[2], 10);
      }
    }
  } catch {
    /* ignore — best-effort */
  }
  return null;
}

export interface RunUpOptions {
  /**
   * Use `next dev` (HMR) for the web app instead of `next start`.
   * Skips the prod build and rebuilds modules on the fly. Slower first
   * page load, far faster iteration loop. Off by default.
   */
  dev?: boolean;
}

export async function runUp(opts: RunUpOptions = {}): Promise<void> {
  // ── 1. Load config (run init if missing) ──────────────────────────────────

  let config = readConfig();
  if (!config) {
    console.log(chalk.yellow('No config found — running init wizard first.\n'));
    config = await runInit();
  }

  const webUrl = `http://localhost:${config.ports.web}`;
  const runnerUrl = `http://localhost:${config.ports.runner}`;

  // ── 1.5 Port-conflict pre-flight ──────────────────────────────────────────
  // Catch orphans from a previous crashed run BEFORE spawning anything.
  // Common cause on Windows: terminal was closed without Ctrl+C, leaving
  // web/runner alive. Without this, EADDRINUSE crashes web mid-startup,
  // triggers shutdown, and leaves the user staring at "Stopping NodalAI…".

  // Sweep orphans automatically. If we detect any of our configured ports
  // are held, kill those PIDs and continue. The user shouldn't have to
  // copy-paste taskkill commands every time their terminal closes badly.
  const orphans: Array<{ name: string; port: number; pid: number }> = [];
  for (const [name, port] of [
    ['web', config.ports.web],
    ['runner', config.ports.runner],
    ['postgres', config.ports.postgres],
  ] as const) {
    const pid = await pidListeningOnPort(port);
    if (pid !== null) orphans.push({ name, port, pid });
  }

  if (orphans.length > 0) {
    console.log(
      chalk.yellow(
        `Found ${orphans.length} orphan process${orphans.length === 1 ? '' : 'es'} on configured ports:`,
      ),
    );
    for (const o of orphans) {
      console.log(chalk.gray(`  - ${o.name} on :${o.port} (pid ${o.pid})`));
    }
    console.log(chalk.yellow('Cleaning up before starting…'));

    const { execa } = await import('execa');
    for (const o of orphans) {
      try {
        if (process.platform === 'win32') {
          // /T = kill the whole process tree (Postgres spawns workers; the
          // parent dying without /T leaves them holding the port).
          await execa('taskkill', ['/T', '/PID', String(o.pid), '/F'], { reject: false });
        } else {
          // SIGKILL the leader; on Unix-likes Postgres workers usually die
          // when the postmaster does. If not we'd need to lookup PG children.
          process.kill(o.pid, 'SIGKILL');
        }
      } catch {
        /* best-effort */
      }
    }

    // Wait for OS to release the port (TCP sockets stick in TIME_WAIT briefly).
    // Re-poll for up to 10s before giving up.
    const deadline = Date.now() + 10_000;
    let stillHeld: typeof orphans = [];
    while (Date.now() < deadline) {
      stillHeld = [];
      for (const o of orphans) {
        const pid = await pidListeningOnPort(o.port);
        if (pid !== null) stillHeld.push({ ...o, pid });
      }
      if (stillHeld.length === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (stillHeld.length > 0) {
      const list = stillHeld.map((o) => `${o.name}:${o.port}=${o.pid}`).join(', ');
      throw new Error(
        `Could not free ports after killing orphans: ${list}. Try again or restart your machine.`,
      );
    }
    console.log(chalk.green('Orphans cleaned up.\n'));
  }

  // ── 2. Start embedded Postgres ────────────────────────────────────────────

  const pgSpinner = ora('Starting embedded Postgres…').start();
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
  try {
    pg = await startEmbeddedPostgres(undefined, config.ports.postgres);
    pgSpinner.succeed(chalk.green(`Postgres ready on port ${config.ports.postgres}`));
  } catch (err) {
    pgSpinner.fail('Failed to start Postgres');
    throw err;
  }

  const databaseUrl = buildDatabaseUrl(config.ports.postgres);

  // ── 3. Apply Drizzle migrations ───────────────────────────────────────────

  const migrateSpinner = ora('Applying database migrations…').start();
  try {
    await runMigrations(databaseUrl, { patchVectorAsText: !pg.vectorAvailable });
    migrateSpinner.succeed(chalk.green('Migrations applied'));
  } catch (err) {
    migrateSpinner.fail('Migration failed');
    await pg.stop();
    throw err;
  }

  // ── 4. Seed default user + entity + agent ─────────────────────────────────

  const seedSpinner = ora('Seeding default user and agent…').start();
  try {
    const { db, close } = createClient(databaseUrl, { max: 5 });
    await seedDefaultUserEntityAgent(db, config.llm.model);
    await close();
    seedSpinner.succeed(chalk.green('Seed complete'));
  } catch (err) {
    seedSpinner.fail('Seed failed');
    await pg.stop();
    throw err;
  }

  // ── 5. Spawn runner ───────────────────────────────────────────────────────

  const runnerEnv = buildEnvForRunner(config, databaseUrl);
  const runnerSpinner = ora('Starting runner…').start();
  const runnerProcess = spawnRunner(runnerEnv);
  const runnerPid = runnerProcess.pid ?? 0;
  runnerSpinner.succeed(chalk.green(`Runner started (pid ${runnerPid})`));

  // ── 6. Spawn web ──────────────────────────────────────────────────────────

  const webEnv = buildEnvForWeb(config, databaseUrl);
  const webSpinnerLabel = opts.dev ? 'Starting web (dev — HMR)…' : 'Starting web…';
  const webSpinner = ora(webSpinnerLabel).start();
  const webProcess = spawnWeb(webEnv, { dev: opts.dev });
  const webPid = webProcess.pid ?? 0;
  webSpinner.succeed(chalk.green(`Web started (pid ${webPid})`));

  // Save PIDs for `nodalai down`
  writePids({ runner: runnerPid, web: webPid });

  // ── 7. Wait for health ────────────────────────────────────────────────────

  const healthSpinner = ora('Waiting for services to be healthy…').start();
  // `next dev` first-compile can blow past 30s on a cold cache.
  const webHealthMs = opts.dev ? 90_000 : 30_000;
  try {
    await Promise.all([waitForHealth(runnerUrl, 30_000), waitForHealth(webUrl, webHealthMs)]);
    healthSpinner.succeed(chalk.green('All services healthy'));
  } catch (err) {
    healthSpinner.fail('Health check timed out');
    killSilent(runnerProcess);
    killSilent(webProcess);
    await pg.stop();
    clearPids();
    throw err;
  }

  // ── 8. Open browser ───────────────────────────────────────────────────────

  await open(webUrl);

  // ── 9. Ready message ──────────────────────────────────────────────────────

  console.log('');
  console.log(chalk.bold.green(`  NodalAI ready at ${webUrl}`));
  if (config.bind === 'lan') {
    console.log(chalk.cyan(`  LAN mode — sign up at ${webUrl}/login`));
  }
  console.log(chalk.gray('  Ctrl+C to stop all services'));
  console.log('');

  // ── 10. Graceful shutdown on SIGINT ───────────────────────────────────────

  const shutdown = async (): Promise<void> => {
    console.log('\n' + chalk.yellow('  Stopping NodalAI…'));
    killSilent(runnerProcess);
    killSilent(webProcess);
    await pg.stop();
    clearPids();
    console.log(chalk.green('  Stopped. Goodbye!'));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Keep process alive until a child exits, then shut down
  await Promise.race([runnerProcess, webProcess]);

  await shutdown();
}
