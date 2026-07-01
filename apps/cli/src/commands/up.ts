// up.ts — start everything: postgres, migrations, seed, runner, web, then open browser

import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { randomBytes } from 'crypto';
import { readConfig, writeConfig, type Config } from '../lib/config.ts';
import { startEmbeddedPostgres, runMigrations, stopOrphanPostgres } from '../lib/postgres.ts';
import { seedDefaultUserEntityAgent } from '../lib/seed.ts';
import {
  buildEnvForRunner,
  buildEnvForWeb,
  buildDatabaseUrl,
  resolveAuthMode,
} from '../lib/env.ts';
import { isPortBindable, findFreePort } from '../lib/ports.ts';
import {
  spawnRunner,
  spawnWeb,
  waitForHealth,
  writePids,
  clearPids,
  killProcessTree,
  isPidAlive,
  waitForPidDead,
  type SpawnResult,
} from '../lib/processes.ts';
import { createClient } from '@nodal-agents/db';

async function killSilent(child: SpawnResult): Promise<void> {
  // Kill the whole process tree — see killProcessTree for the Windows
  // rationale (cmd.exe wrapper would otherwise leave node.exe orphaned and
  // the listener port held).
  await killProcessTree(child);
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
  // ── 1. Load config (write a no-friction default if missing) ───────────────

  let config = readConfig();
  if (!config) {
    // First run with no config: skip the interactive terminal wizard entirely.
    // Write a sensible default (loopback → local-trust, no login, no LLM) and
    // let the BROWSER onboarding flow collect the model + create the first
    // agent. The runner boots keyless (seed-llm-key finds no LLM_* env and
    // simply skips), so the dashboard's onboarding is reached on first load.
    //
    // Power users who want LAN / email-auth / a pre-baked LLM key still run
    // `nodal-agents init` explicitly — that path is unchanged.
    console.log(chalk.cyan('  First run — opening the dashboard to finish setup…\n'));
    const defaultConfig: Config = {
      // No `llm` section: the browser onboarding sets it via createLlmKeyAction.
      ports: { web: 3000, runner: 3001, postgres: 25432 },
      workerSecret: randomBytes(32).toString('hex'),
      serverActionsKey: randomBytes(32).toString('base64'),
      // loopback derives auth: local-trust (no login/signup). Leave `auth`
      // unset so resolveAuthMode falls back to the loopback → local-trust map.
      bind: 'loopback',
    };
    writeConfig(defaultConfig);
    config = defaultConfig;
  }

  // URLs are computed after the port-rotation guard below — config.ports may
  // change between here and there if the OS has reserved the configured port.

  // ── 1.5 Port-conflict pre-flight ──────────────────────────────────────────
  // Catch orphans from a previous crashed run BEFORE spawning anything.
  // Common cause on Windows: terminal was closed without Ctrl+C, leaving
  // web/runner alive. Without this, EADDRINUSE crashes web mid-startup,
  // triggers shutdown, and leaves the user staring at "Stopping Nodal-Agents…".

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
    // Postgres needs SPECIAL handling. Its Win32 shared-memory section is
    // keyed to the DATA DIR, not the port — so rotating to a neighbouring
    // port (section 1.6 below) while an orphan postmaster still lives does
    // NOT help: the new postgres reattaches the same SHM key and dies with
    // FATAL "pre-existing shared memory block is still in use". The only real
    // fix is to make the orphan actually exit (which releases the SHM):
    //   1. `pg_ctl stop -m fast` (graceful — releases SHM cleanly), then
    //   2. tree-kill as a fallback, then
    //   3. VERIFY the pid is dead. If it survives, abort loudly with an
    //      actionable message instead of rotating into the misleading FATAL.
    const pgOrphan = orphans.find((o) => o.name === 'postgres');
    if (pgOrphan) {
      await stopOrphanPostgres();
      if (isPidAlive(pgOrphan.pid)) {
        try {
          // Kill the postmaster DIRECTLY — NOT `taskkill /T`. Walking the
          // postgres backend tree with /T HANGS on Windows (proven live: it
          // timed out, leaving the orphan alive and `up` aborting on the throw
          // below). TerminateProcess on the postmaster pid is instant; its
          // backends detect the dead postmaster and self-exit, releasing the
          // SHM. `process.kill(pid,'SIGKILL')` is TerminateProcess on Windows
          // (same as `Stop-Process -Force`, which is what actually worked) and
          // SIGKILL on Unix.
          process.kill(pgOrphan.pid, 'SIGKILL');
        } catch {
          /* best-effort — already gone */
        }
        await waitForPidDead(pgOrphan.pid, 5000);
      }
      if (isPidAlive(pgOrphan.pid)) {
        const killCmd =
          process.platform === 'win32'
            ? `powershell Stop-Process -Id ${pgOrphan.pid} -Force`
            : `kill -9 ${pgOrphan.pid}`;
        throw new Error(
          `An orphaned Postgres (pid ${pgOrphan.pid}) is still running and holds the ` +
            `shared-memory block for the data dir. Rotating ports won't help — the SHM ` +
            `segment is keyed to the data dir, not the port.\n` +
            `  Fix: run \`nodal-agents down\`, then \`${killCmd}\`. If it persists, reboot ` +
            `to clear the orphan kernel object. No data is lost — pg-data is preserved.`,
        );
      }
    }

    for (const o of orphans) {
      if (o.name === 'postgres') continue; // already handled above
      try {
        if (process.platform === 'win32') {
          // /T = kill the whole process tree (the parent dying without /T
          // leaves children holding the port).
          await execa('taskkill', ['/T', '/F', '/PID', String(o.pid)], { reject: false });
        } else {
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
      // Windows can leave a "ghost socket" bound to a dead pid — the process
      // is reaped but the TCP/IP driver hasn't released the port. Don't bail
      // here; the port-rotation guard below (section 1.6) will detect that
      // the port is unbindable and rotate to a free neighbour. The user gets
      // a working stack on a new port instead of a copy-paste taskkill chore.
      const list = stillHeld.map((o) => `${o.name}:${o.port}=${o.pid}`).join(', ');
      console.log(chalk.yellow(`Some ports still held (likely Windows ghost sockets): ${list}.`));
      console.log(chalk.gray('Will rotate to free neighbours below.\n'));
    } else {
      console.log(chalk.green('Orphans cleaned up.\n'));
    }
  }

  // ── 1.6 Port-reservation guard (Windows Hyper-V/WinNAT excluded ranges) ──
  // Even with no orphan, a port can be unbindable because the OS has
  // reserved it. listen() returns EACCES and we'd fail downstream with a
  // confusing "Postgres start failed". Probe each configured port; if it's
  // not bindable, rotate to a free one nearby and persist so the next boot
  // uses the working port directly.

  const portChanges: Array<{ name: 'web' | 'runner' | 'postgres'; from: number; to: number }> = [];
  for (const name of ['web', 'runner', 'postgres'] as const) {
    const configured = config.ports[name];
    if (await isPortBindable(configured)) continue;
    const next = await findFreePort(configured + 1);
    portChanges.push({ name, from: configured, to: next });
    config.ports[name] = next;
  }

  if (portChanges.length > 0) {
    console.log(chalk.yellow('Configured ports unavailable — rotating:'));
    for (const c of portChanges) {
      console.log(chalk.gray(`  - ${c.name}: ${c.from} → ${c.to}`));
    }
    writeConfig(config);
    console.log(chalk.gray('  Updated ~/.nodalai/config.json.\n'));
  }

  // Now that ports are finalised, derive the user-facing URLs.
  const webUrl = `http://localhost:${config.ports.web}`;
  // 127.0.0.1, not localhost: in loopback mode the runner binds IPv4 127.0.0.1
  // only (see buildEnvForRunner). On Windows `localhost` resolves to ::1 (IPv6)
  // first, so a health probe to http://localhost:<runner> hits an address the
  // runner never listens on → the check times out even though the runner is up.
  // The web is fine on localhost because Next.js binds 0.0.0.0 (incl. ::1).
  const runnerUrl = `http://127.0.0.1:${config.ports.runner}`;

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

  // ── 4. Seed default user + entity + agent (local-trust only) ─────────────
  // The LOCAL_USER / LOCAL_ENTITY pair is the single identity used in
  // local-trust mode (no auth). In local-auth or bearer-token modes the
  // user creates their own entity at signup; seeding the local pair here
  // would leave the env-derived LLM key attached to a phantom entity the
  // signed-up user never sees — which is exactly the "no LLM configured"
  // bug we fixed in v0.1.3+.

  const authMode = resolveAuthMode(config);
  if (authMode === 'local-trust') {
    const seedSpinner = ora('Seeding default user and agent…').start();
    try {
      const { db, close } = createClient(databaseUrl, { max: 5 });
      await seedDefaultUserEntityAgent(db, config.llm?.model ?? null);
      await close();
      seedSpinner.succeed(chalk.green('Seed complete'));
    } catch (err) {
      seedSpinner.fail('Seed failed');
      await pg.stop();
      throw err;
    }
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

  // Save PIDs for `nodal-agents down`
  writePids({ runner: runnerPid, web: webPid });

  // ── 7. Wait for health ────────────────────────────────────────────────────

  const healthSpinner = ora('Waiting for services to be healthy…').start();
  // First run on a CLEAN machine is heavy and slow, and this is where a too-tight
  // budget bites hardest: embedded-postgres fetches its ~70MB binary at runtime
  // (its postinstall may be blocked by npm script-approval), the runner loads a
  // large module graph (googleapis et al.) off a cold disk cache, and seeds 19
  // system skills — all before it answers /api/health. On a warm machine this is
  // quick (<20s); on a fresh install it routinely blows past a minute, which is
  // exactly what tore the stack down for fresh installers (runner "did not become
  // healthy within 60000ms"). `next dev`/`next start` first-compile is similarly
  // slow from a cold cache. So the cold-start budget is generous — 5 minutes —
  // and env-overridable for very slow disks/connections.
  const webHealthMs = Number(process.env['NODALAI_WEB_HEALTH_MS']) || 300_000;
  const runnerHealthMs = Number(process.env['NODALAI_RUNNER_HEALTH_MS']) || 300_000;
  try {
    await Promise.all([
      waitForHealth(runnerUrl, runnerHealthMs),
      waitForHealth(webUrl, webHealthMs),
    ]);
    healthSpinner.succeed(chalk.green('All services healthy'));
  } catch (err) {
    healthSpinner.fail('Health check timed out');
    // IMPORTANT: tree-kill BOTH children (and await) so no orphan node.exe
    // survives to hold the port. Skipping this is what causes the next
    // `nodal-agents up` to fail at health check: the new runner can't bind on
    // :3001 because the old one is still alive behind a dead cmd.exe parent.
    await Promise.allSettled([killSilent(runnerProcess), killSilent(webProcess)]);
    await pg.stop();
    clearPids();
    // The first run on a fresh machine is slow (Postgres binary fetched at
    // runtime, a large module graph loaded off a cold disk cache). A retry runs
    // warm — binary cached, modules loaded — and usually comes up fast.
    console.error(
      chalk.yellow(
        '\n  First run on a fresh machine can take a while to warm up.\n' +
          '  → Run `nodal-agents up` again — it starts much faster the second time.\n' +
          '  → Still timing out after a retry? Raise the budget: set NODALAI_RUNNER_HEALTH_MS=600000\n',
      ),
    );
    throw err;
  }

  // ── 7.5 Non-blocking version notice ──────────────────────────────────────
  // Fire-and-forget: if a newer version is available, print one informational
  // line. Must never delay the ready message or throw — all errors are swallowed.
  // The race against a short timer ensures this can't stall the output.
  void (async () => {
    try {
      const { getInstalledVersion, getLatestVersion } = await import('../lib/version.ts');
      const installed = getInstalledVersion();
      // Timeout already capped inside getLatestVersion() at 5 s; we add an
      // outer race of 3 s here so any internal delay can't push the notice
      // after the ready block.
      const latest = await Promise.race([
        getLatestVersion(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
      ]);
      if (latest !== null && latest !== installed) {
        console.log(chalk.cyan(`  ℹ v${latest} available — run \`nodal-agents update\``));
      }
    } catch {
      /* completely silent — version notice must never disrupt startup */
    }
  })();

  // ── 8. Open browser ───────────────────────────────────────────────────────
  // NODALAI_NO_BROWSER=1 disables this — set it on headless servers / CI
  // runners with no desktop, where `open` would either hang or crash.
  if (!process.env['NODALAI_NO_BROWSER']) {
    try {
      await open(webUrl);
    } catch {
      /* best-effort — headless environments without xdg-open shouldn't crash up */
    }
  }

  // ── 9. Ready message ──────────────────────────────────────────────────────

  console.log('');
  console.log(chalk.bold.green(`  Nodal-Agents ready at ${webUrl}`));
  if (config.bind === 'lan') {
    console.log(chalk.cyan(`  LAN mode — sign up at ${webUrl}/login`));
  }
  console.log(chalk.gray('  Ctrl+C to stop all services'));
  console.log('');

  // ── 10. Graceful shutdown on SIGINT ───────────────────────────────────────

  const shutdown = async (): Promise<void> => {
    console.log('\n' + chalk.yellow('  Stopping Nodal-Agents…'));
    await Promise.allSettled([killSilent(runnerProcess), killSilent(webProcess)]);
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
