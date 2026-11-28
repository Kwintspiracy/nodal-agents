// cluster-session.ts — the home's embedded cluster, for the commands that are
// not `up`: `rollback`, `backup`, `restore`.
//
// ONE way to reach the database outside `up`, so the three commands cannot
// drift apart: the same binaries check, the same port decision, the same
// password start (a change cut in half is finished, a refused password says
// what to put back), and the cluster stopped once the command is done. A
// command that must not run beside the stack (a swap needs no session on the
// database) asks `refuseWhileRunning` first; `backup` reads a running stack's
// database as it is, through one snapshot.

import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, PG_DATA_DIR, ensureConfigDir, writeConfig, type Config } from './config.ts';
import {
  LEGACY_PG_PASSWORD,
  PostgresAuthError,
  livePostmasterPid,
  startEmbeddedPostgres,
  type PostgresHandle,
} from './postgres.ts';
import {
  finishPasswordChange,
  passwordMismatchMessage,
  startWithPassword,
  type PasswordStart,
} from './pg-password.ts';
import { buildDatabaseUrl } from './env.ts';
import { allocateServicePorts, formatPortRotation, pidListeningOnPort } from './ports.ts';
import { isPidAlive, readPids } from './processes.ts';
import { ensureDatabaseBinaries } from '../commands/up.ts';
import { lastGoodCopyPath } from '@nodal-agents/shared/state-files';

/** What is running out of this home, as observed; empty when nothing is. */
export function runningNow(): string[] {
  const seen: string[] = [];
  const postmaster = livePostmasterPid(PG_DATA_DIR);
  if (postmaster !== null) seen.push(`postgres pid ${postmaster}`);
  const pids = readPids();
  for (const [label, pid] of [
    ['runner', pids?.runner],
    ['web', pids?.web],
  ] as const) {
    if (pid !== undefined && isPidAlive(pid)) seen.push(`${label} pid ${pid}`);
  }
  return seen;
}

/**
 * Throw when anything of this home runs. `what` completes "… only while
 * nothing uses the database": "A copy can be swapped back".
 */
export function refuseWhileRunning(what: string): void {
  const running = runningNow();
  if (running.length > 0) {
    throw new Error(
      `Nodal-Agents is running out of this home (${running.join(', ')}).\n` +
        `  ${what} only while nothing uses the database. Stop it first:\n\n` +
        '    nodal-agents down\n\n' +
        '  Nothing was changed.',
    );
  }
}

/** True when this home holds a database cluster. */
export function homeHasCluster(): boolean {
  return existsSync(join(PG_DATA_DIR, 'PG_VERSION'));
}

export interface ClusterSession {
  readonly databaseUrl: string;
  /** True when pgvector loaded: the migrations keep their `vector` columns. */
  readonly vectorAvailable: boolean;
  /** The config as it is on disk once the cluster is started. */
  readonly config: Config;
}

/**
 * Start this home's cluster the way `up` does, run `fn`, stop the cluster.
 * A cluster that does not exist yet is created (initdb, with the config's
 * password), as `up` does on a first start.
 */
export async function withStartedCluster<T>(
  initial: Config,
  fn: (session: ClusterSession) => Promise<T>,
): Promise<T> {
  await ensureDatabaseBinaries();
  ensureConfigDir();
  let config = initial;
  const allocation = await allocateServicePorts(config.ports);
  if (allocation.moved.length > 0) {
    config = { ...config, ports: { ...config.ports, ...allocation.ports } };
    writeConfig(config);
    console.log(chalk.yellow('Configured ports unavailable — rotating:'));
    const rotations = await Promise.all(
      allocation.moved.map(async (m) => ({ ...m, heldBy: await pidListeningOnPort(m.from) })),
    );
    for (const line of formatPortRotation(rotations)) console.log(chalk.gray(line));
  }
  let started: PasswordStart<PostgresHandle>;
  try {
    started = await startWithPassword(config, {
      start: (password) => startEmbeddedPostgres(undefined, config.ports.postgres, password),
      save: (next) => writeConfig(next),
      mint: () => randomBytes(24).toString('base64url'),
    });
  } catch (err) {
    if (err instanceof PostgresAuthError) {
      const lastGood = lastGoodCopyPath(CONFIG_FILE);
      throw new Error(
        passwordMismatchMessage(CONFIG_FILE, existsSync(lastGood) ? lastGood : null),
        {
          cause: err,
        },
      );
    }
    throw err;
  }
  const pg = started.pg;
  try {
    const finished = await finishPasswordChange(started, {
      save: (next) => writeConfig(next),
      warn: (message) => console.warn(chalk.yellow(message.replace(/^/gm, '  '))),
    });
    return await fn({
      databaseUrl: buildDatabaseUrl(finished.config.ports.postgres, finished.password),
      vectorAvailable: pg.vectorAvailable,
      config: finished.config,
    });
  } finally {
    await pg.stop();
  }
}

/**
 * The home's database as it is: the running stack's cluster when one runs
 * (left running), else a cluster started for `fn` and stopped after it.
 */
export async function withHomeDatabase<T>(
  config: Config,
  fn: (session: Pick<ClusterSession, 'databaseUrl' | 'config'>) => Promise<T>,
): Promise<T> {
  if (livePostmasterPid(PG_DATA_DIR) !== null) {
    // The running stack finished any password change when it started.
    const password = config.postgresPassword ?? LEGACY_PG_PASSWORD;
    return fn({ databaseUrl: buildDatabaseUrl(config.ports.postgres, password), config });
  }
  return withStartedCluster(config, fn);
}
