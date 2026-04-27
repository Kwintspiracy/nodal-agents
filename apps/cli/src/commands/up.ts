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

export async function runUp(): Promise<void> {
  // ── 1. Load config (run init if missing) ──────────────────────────────────

  let config = readConfig();
  if (!config) {
    console.log(chalk.yellow('No config found — running init wizard first.\n'));
    config = await runInit();
  }

  const webUrl = `http://localhost:${config.ports.web}`;
  const runnerUrl = `http://localhost:${config.ports.runner}`;

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
  const webSpinner = ora('Starting web…').start();
  const webProcess = spawnWeb(webEnv);
  const webPid = webProcess.pid ?? 0;
  webSpinner.succeed(chalk.green(`Web started (pid ${webPid})`));

  // Save PIDs for `nodalai down`
  writePids({ runner: runnerPid, web: webPid });

  // ── 7. Wait for health ────────────────────────────────────────────────────

  const healthSpinner = ora('Waiting for services to be healthy…').start();
  try {
    await Promise.all([waitForHealth(runnerUrl, 30_000), waitForHealth(webUrl, 30_000)]);
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
  if (config.bind === 'lan' && config.bearerToken) {
    console.log(chalk.yellow(`  LAN bearer token: ${config.bearerToken}`));
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
