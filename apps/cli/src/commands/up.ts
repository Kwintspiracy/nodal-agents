// up.ts — start everything: postgres, migrations, seed, runner, web, then open browser

import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  readConfig,
  writeConfig,
  createConfig,
  newInstallConfig,
  ensureConfigDir,
  CONFIG_FILE,
  LOG_DIR,
  PG_DATA_DIR,
} from '../lib/config.ts';
import {
  startEmbeddedPostgres,
  migrateDatabase,
  stopOrphanPostgres,
  livePostmasterPid,
  postgresProcessesForDataDir,
  PostgresAuthError,
} from '../lib/postgres.ts';
import {
  startWithPassword,
  finishPasswordChange,
  passwordMismatchMessage,
  type PasswordStart,
} from '../lib/pg-password.ts';
import { lastGoodCopyPath } from '@nodal-agents/shared/state-files';
import {
  probeEmbeddedPostgres,
  hydrateEmbeddedPostgres,
  loadPlatformBinaries,
  EmbeddedPostgresUnavailableError,
} from '../lib/embedded-postgres-binaries.ts';
import { ensureVcRuntime, formatVersion, shippedVcRuntimeDir } from '../lib/vc-runtime.ts';
import { seedDefaultUserEntityAgent } from '../lib/seed.ts';
import {
  buildEnvForRunner,
  buildEnvForWeb,
  buildDatabaseUrl,
  resolveAuthMode,
} from '../lib/env.ts';
import {
  allocateServicePorts,
  pidListeningOnPort,
  formatPortRotation,
  type PortRotation,
} from '../lib/ports.ts';
import { measuredPort } from '../lib/orphans.ts';
import { decideStartFromProbes, AlreadyRunningError } from '../lib/already-running.ts';
import {
  confirmRecordedPid,
  formatRefusal,
  unconfirmedIdentityNotice,
} from '../lib/pid-confirm.ts';
import { logLauncherEvent, LAUNCHER_LOG } from '../lib/launcher-log.ts';
import {
  spawnRunner,
  spawnWeb,
  waitForHealth,
  assertWebRenders,
  clearPids,
  readPids,
  recordServiceTree,
  type RecordOutcome,
  sweepRecordedChildren,
  killProcessTree,
  killPidTree,
  recordedRoot,
  processSnapshotWin,
  ProcessReading,
  walkDescendants,
  isPidAlive,
  waitForPidDead,
  type SpawnResult,
  type ProcessRecord,
} from '../lib/processes.ts';
import { createClient, assertMasterKeyRestorable } from '@nodal-agents/db';
import { DatabaseNewerThanProgramError } from '@nodal-agents/db/schema-state';
import { MigrationFailedError, MigrationGapError, errorChain } from '@nodal-agents/db/safe-migrate';
import {
  DEFAULT_SNAPSHOTS_KEPT,
  SnapshotError,
  formatBytes,
  homeStateFiles,
} from '@nodal-agents/db/snapshots';
import {
  databaseNewerRefusal,
  migrationFailure,
  snapshotRefusal,
  unclaimedHistoryNotice,
} from '../lib/schema-messages.ts';
import { getInstalledVersion } from '../lib/version.ts';
import { startHealthWatchdog, probeRunnerHealth, type Watchdog } from '../lib/watchdog.ts';

async function killSilent(child: SpawnResult): Promise<void> {
  // Kill the whole process tree — see killProcessTree for the Windows
  // rationale (cmd.exe wrapper would otherwise leave node.exe orphaned and
  // the listener port held).
  await killProcessTree(child);
}

/**
 * Print the tail of a service's log file, or say plainly that there is nothing
 * to show. Called on the health-check failure path, where the log holds the
 * actual diagnosis and the timeout message holds none of it.
 *
 * Never throws: this runs while we are already failing, and a missing or
 * unreadable log must not replace the original error with a second one.
 */
function printLogTail(service: 'runner' | 'web' | string, lines: number): void {
  const logFile = join(LOG_DIR, `${service}.log`);
  try {
    if (!existsSync(logFile)) {
      console.error(chalk.gray(`\n  ${service}: no log at ${logFile}`));
      return;
    }
    const tail = readFileSync(logFile, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(-lines);
    if (tail.length === 0) {
      console.error(chalk.gray(`\n  ${service}: log is empty (${logFile})`));
      return;
    }
    console.error(chalk.yellow(`\n  Last ${tail.length} lines of ${service}.log:`));
    for (const line of tail) console.error(chalk.gray(`    ${line}`));
    console.error(chalk.gray(`  Full log: ${logFile}`));
  } catch {
    console.error(chalk.gray(`\n  ${service}: could not read ${logFile}`));
  }
}

/**
 * Ce que le lanceur dit quand il REFUSE de servir une base à trous (#298).
 *
 * Écrit à part pour une raison : c'est la seule chose que la personne verra,
 * et `runUp` est trop grosse pour qu'un test la joue. Ici, un test peut
 * vérifier que chaque migration manquante est NOMMÉE et que la commande de
 * réparation REND LE DÉMARRAGE QU'ON AVAIT. Les deux drapeaux comptent :
 * `--dev` pour ne pas renvoyer un poste de développement sur un build de
 * production, et `--detach` parce qu'une commande sans lui rendrait au
 * terminal une stack qu'on avait détachée, et elle mourrait avec lui. Le
 * démarrage avec la machine (#451 : valeur Run sous Windows, LaunchAgent,
 * unité systemd) lance `up` au PREMIER PLAN, jamais `--detach` : détaché, le
 * lanceur sortirait et launchd ou systemd n'auraient plus rien à relancer
 * (`autostart.ts`).
 */
export function migrationGapRefusal(
  gaps: readonly { tag: string }[],
  opts: { dev: boolean; detach: boolean },
): string {
  const combien = `${gaps.length} migration${gaps.length === 1 ? '' : 's'}`;
  return [
    `The database is missing ${combien} the journal announces:`,
    '',
    ...gaps.map((g) => `    ${g.tag}`),
    '',
    '  Tables are short of columns the code expects, so writes to them will fail.',
    '  Nodal-Agents will not serve a database in that state.',
    '',
    '  Apply them with:',
    '',
    `    nodal-agents up --repair-migrations${opts.dev ? ' --dev' : ''}${opts.detach ? ' --detach' : ''}`,
  ].join('\n');
}

export interface RunUpOptions {
  /**
   * Use `next dev` (HMR) for the web app instead of `next start`.
   * Skips the prod build and rebuilds modules on the fly. Slower first
   * page load, far faster iteration loop. Off by default.
   */
  dev?: boolean;
  /**
   * Hand the terminal back once everything is healthy, leaving the services
   * running. `nodal-agents down` stops them, `nodal-agents logs` reads them.
   *
   * Without this, `up` is the whole product's lifetime: closing the terminal —
   * or logging out, or rebooting — takes down the runner, and with it every
   * schedule, the curator, and the community-skill update watch. Those crons
   * exist and are correct; they simply never got to run overnight.
   *
   * Not a service manager. It survives the terminal, not the reboot; the
   * machine's own startup manager (the Windows Run key, launchd, systemd) is
   * what puts Nodal back after a restart, and it runs `up` in the foreground,
   * never `--detach`, so it has a process to watch (#451, `autostart.ts`).
   */
  detach?: boolean;
  /**
   * Apply the migrations the journal announces and the database never got,
   * instead of refusing to serve because of them (issue #298).
   *
   * The gesture lives HERE, and not in a `db repair` of its own, because a
   * repair needs the embedded Postgres already running and `up` is the only
   * command in the CLI that starts it. A standalone command would have had to
   * duplicate the whole cluster lifecycle — start, wait, stop, orphan
   * detection — to do the same three statements.
   */
  repairMigrations?: boolean;
  /**
   * Do not download the page renderer at this start (#1082). The same as
   * `"pageRenderer": { "autoInstall": false }` in config.json, for one start.
   */
  skipRendererInstall?: boolean;
}

/**
 * The embedded database's binaries are there and can run: steps 0 and 0b of
 * `up`, shared with every command that starts the cluster itself
 * (`rollback`). Throws `EmbeddedPostgresUnavailableError` when they are not.
 */
export async function ensureDatabaseBinaries(): Promise<void> {
  // ── 0. Are the database binaries actually there? (issue #247) ─────────────
  //
  // Demandé AVANT tout le reste, config comprise : sans binaires il n'y a rien
  // à démarrer, et l'erreur qui sortait jusqu'ici venait du postmaster, trois
  // couches plus bas, sans jamais nommer la porte `allowScripts` des npm
  // récents ni la commande qui la lève. Le détail du constat est dans
  // lib/embedded-postgres-binaries.ts.
  let binaries = await probeEmbeddedPostgres();
  // npm 11.17+ no longer runs install scripts unapproved: the library links the
  // package's postinstall would create are created here instead, then the
  // install is read again (0.9.7, lib/embedded-postgres-binaries.ts).
  if (!binaries.ok && binaries.reason === 'HYDRATION_SKIPPED') {
    await hydrateEmbeddedPostgres();
    binaries = await probeEmbeddedPostgres();
  }
  if (!binaries.ok) {
    throw new EmbeddedPostgresUnavailableError(binaries.reason, binaries.message);
  }

  // ── 0b. Windows: the VC++ runtime the database binaries need (0.9.7) ──────
  //
  // Placed next to postgres.exe from the copy the pack carries, so that a
  // machine with an old System32 runtime boots without installing anything.
  // Why, measured, and the fallback: lib/vc-runtime.ts.
  if (process.platform === 'win32') {
    const platform = await loadPlatformBinaries();
    if (platform !== null) {
      const outcome = ensureVcRuntime({
        binDir: dirname(platform.postgres),
        shippedDir: shippedVcRuntimeDir(),
        systemDir: join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32'),
      });
      if (outcome.kind === 'system') {
        console.log(
          `  Visual C++ runtime: using the system's ${formatVersion(outcome.version)} ` +
            `(could not place Nodal's copy: ${outcome.copyError})`,
        );
      }
    }
  }
}

export async function runUp(opts: RunUpOptions = {}): Promise<void> {
  await ensureDatabaseBinaries();

  // ── 1. Load config (write a no-friction default if missing) ───────────────
  //
  // `readConfig` answers null for an ABSENT file only. A file that exists but
  // cannot be read or understood throws here, before anything is started or
  // written: it holds the only copy of the database password, and treating it
  // as a first run is what used to write defaults over it (B38-02).

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
    //
    // `createConfig` refuses when this home already holds an install (a
    // database, a master key, a last good copy): a missing config there is a
    // loss to repair, not a first run.
    const defaultConfig = newInstallConfig();
    createConfig(defaultConfig);
    console.log(chalk.cyan('  First run — opening the dashboard to finish setup…\n'));
    config = defaultConfig;
  }

  // ── 1.1 Open this instance's home (NODALAI_HOME) ─────────────────────────
  // Every boot, not only the first: an existing config writes nothing, and the
  // home must still be declared in the per-user registry before Postgres or
  // the runner touch it (packages/shared/src/nodal-instances.ts, openNodalHome).
  // A failure stops `up`.
  ensureConfigDir();

  // Fail fast on a dangerous config combination (local-trust + LAN bind =
  // unauthenticated RCE surface) BEFORE starting Postgres or spawning any
  // process — resolveAuthMode throws; see apps/cli/src/lib/env.ts.
  resolveAuthMode(config);

  // ── 1.4 Is it ALREADY RUNNING? Asked before anything is touched ───────────
  //
  // On 2026-09-15 at 21:05 a `pnpm dev` in the repo ran this command against a
  // healthy install, and the pre-flight below classified the live runner, web
  // and postgres as orphans and killed all three. The turbo run then failed, so
  // nothing replaced them; the stack was down for two and a half hours
  // (issue #117).
  //
  // The pre-flight is not wrong about orphans — it is missing a category. So
  // the question is asked HERE, ahead of the recorded-children sweep, ahead of
  // the port probe, ahead of every kill: is the product already up out of this
  // data directory? When it is, nothing is signalled and nothing is swept.
  const startVerdict = await decideStartFromProbes({
    runnerPort: config.ports.runner,
    webPort: config.ports.web,
    dataDir: PG_DATA_DIR,
  });
  if (!startVerdict.proceed) {
    logLauncherEvent('refused-kill', `already-running runner=${config.ports.runner}`);
    throw new AlreadyRunningError(startVerdict.message);
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
  // A PID holding one of our ports is NOT automatically ours.
  //
  // This swept every listener and killed it. On 2026-08-21 an unrelated dev
  // server sat on :3000; `up` called it an "orphan", killed it, and started
  // normally — destroying someone else's work to free a port we merely wanted.
  //
  // A process counts as ours only if we can show it: either it is a PID we
  // recorded ourselves in ~/.nodalai/pids/processes.json, or it descends from
  // one. Anything else is a stranger — we refuse to start and say so, which is
  // recoverable, instead of killing it, which is not.
  const known = readPids();

  // FIRST, sweep what the previous run recorded — before any port is probed.
  //
  // This is the only cleanup that survives a hard kill, and a hard kill is what
  // Ctrl+C actually is here. Under a .cmd launcher, cmd.exe answers Ctrl+C with
  // "Terminate batch job (Y/N)?" and then destroys the whole tree at once — our
  // CLI included, in the middle of its own shutdown handler. Verified live on
  // 2026-08-21: the terminal showed the prompt returning BEFORE the handler's
  // own "Stopping Nodal-Agents…" line, and the CLI process was simply gone,
  // leaving three web-side processes behind.
  //
  // No amount of care inside that handler helps — it does not get to finish.
  // What does survive is the tree recorded on disk while everything was
  // healthy, so recovery belongs on the NEXT start, reading that record.
  //
  // It also reaches what a port scan never will: the deepest Turbopack worker
  // listens on nothing, so it is invisible to the probe below and would
  // otherwise accumulate, one per interrupted session, until the next reboot.
  // Which postgres processes belong to THIS data dir. Asked ONCE, and asked
  // BEFORE the first kill of the boot rather than after it: the leftover sweep
  // below force-kills recorded pids, and until #100 it did so without ever
  // consulting ownership. A recorded pid recycled onto a foreign postmaster was
  // indistinguishable from our own straggler.
  const pgTable = await postgresProcessesForDataDir();
  const ownedPgPids = new Set<number>(pgTable.owned);

  const leftovers = await sweepRecordedChildren(known?.children ?? [], ownedPgPids);
  if (leftovers.length > 0) {
    console.log(
      chalk.gray(`  Cleaned up ${leftovers.length} process(es) left by the previous session`),
    );
  }

  // Ownership, for the port probe below. The recorded children count as ours:
  // after a hard kill their parents are gone, so a live descendant walk finds
  // nothing and a survivor holding :3000 would be misjudged a stranger — which
  // would make `up` refuse to start rather than recover, a worse outcome than
  // the orphan it replaced.
  const ourPids = new Set<number>(
    [known?.runner, known?.web].filter((p): p is number => typeof p === 'number' && p > 0),
  );
  for (const child of known?.children ?? []) ourPids.add(child.pid);

  // ONE snapshot, walked once per root — not one snapshot per root.
  //
  // This used to be `Promise.all(roots.map(descendantPidsWin))`, which spawns a
  // PowerShell per root. Harmless with two roots; adding the recorded children
  // above quietly took it to a dozen concurrent WMI enumerations, and on a
  // two-core machine they throttle each other into the ground. On Windows CI
  // every one of them timed out — first at 6s, then at 20s — and each timeout
  // returned an empty table, so the guard disabled itself while looking like a
  // machine with nothing to clean. Reading the table once is both faster and
  // more correct: every root is then judged against the same instant.
  const snapshot = await processSnapshotWin();
  for (const root of [...ourPids]) {
    for (const rec of walkDescendants(snapshot, root)) ourPids.add(rec.pid);
  }

  // A pid is attributed to a port only where a listener probe MEASURED it.
  // Until 2026-09-14 the data-dir probe stapled `config.ports.postgres` to
  // every pid it returned; the boot that killed another install's postmaster
  // printed thirteen lines claiming :25450 for processes listening elsewhere or
  // on nothing at all (issue #97).
  const listeners: Array<{ name: string; port: number; pid: number }> = [];
  for (const [name, port] of [
    ['web', config.ports.web],
    ['runner', config.ports.runner],
    ['postgres', config.ports.postgres],
  ] as const) {
    const pid = await pidListeningOnPort(port);
    if (pid !== null) listeners.push({ name, port, pid });
  }

  /**
   * Is this pid one of ours? ONE answer, from ONE place.
   *
   * It used to fall back to `livePostmasterPid()` whenever the process table
   * could not be read — a second, looser answer to the same question, and it
   * accepted pids the confirmed set had already refused (pass-4 finding R1).
   * `postgresProcessesForDataDir` now covers that case itself, so a refusal
   * cannot be walked around.
   */
  const isOurPostmasterPid = (pid: number): boolean => ownedPgPids.has(pid);

  const orphans: Array<{ name: string; port: number | null; pid: number }> = [];
  const strangers: Array<{ name: string; port: number; pid: number }> = [];
  for (const { name, port, pid } of listeners) {
    // Postgres is not in our pid file (pg_ctl owns the postmaster), so the
    // ownership test above cannot speak for it — the DATA DIR does. Holding
    // our configured port proves nothing: another install can sit there, and
    // killing it is exactly the incident of 2026-09-14.
    const ours = name === 'postgres' ? isOurPostmasterPid(pid) : ourPids.has(pid);
    if (ours) orphans.push({ name, port, pid });
    else strangers.push({ name, port, pid });
  }

  if (strangers.length > 0) {
    const lines = strangers
      .map((s) => `  - :${s.port} is held by pid ${s.pid}, which Nodal-Agents did not start`)
      .join('\n');
    throw new Error(
      `Port conflict with a process that is not ours:\n${lines}\n\n` +
        `  Nodal-Agents will not kill a process it did not start — it could be your own\n` +
        `  work. Stop it yourself, or change the port in ${CONFIG_FILE}.`,
    );
  }

  // Postgres gets a SECOND probe, by DATA DIR. A port scan only sees a process
  // holding a socket, and the orphan that actually hurts holds none: a
  // postmaster that died during startup, or is stuck mid-shutdown, has no
  // listener left but still owns the Win32 shared-memory section — which is
  // keyed to the data dir, not the port. `up` would then sail past this
  // pre-flight and fail further down with the opaque FATAL "pre-existing
  // shared memory block is still in use", which is precisely what happened on
  // a live machine on 2026-08-20 (rebooting did not clear it; the port scan
  // reported all ports free throughout).
  if (!orphans.some((o) => o.name === 'postgres')) {
    const pgPid = livePostmasterPid();
    if (pgPid !== null && isOurPostmasterPid(pgPid)) {
      orphans.push({ name: 'postgres', port: measuredPort(pgPid, listeners), pid: pgPid });
    } else if (pgPid !== null) {
      // The lockfile names a pid the confirmed set refused, and which has not
      // been seen to exit. Say so: the alternative is a boot that looks clean
      // while an orphan we declined to identify still holds the shared-memory
      // block.
      console.log(
        chalk.yellow(
          `  - postmaster.pid in ${PG_DATA_DIR} names pid ${pgPid}, which has not been seen\n` +
            `    to exit. Its identity could NOT be confirmed: its start time differs from\n` +
            `    the one recorded, or it does not run out of that directory, or at least\n` +
            `    one of those two could not be read. Nothing was stopped. If Postgres then\n` +
            `    fails to start, check that pid yourself (its executable, its start time,\n` +
            `    which cluster it serves) and stop it through its owner rather than killing\n` +
            `    the number.`,
        ),
      );
    }
  }

  // THIRD probe: ask the OS which postgres processes this install owns. It runs
  // whatever the two above found — see the note below the paragraph.
  //
  // Both probes above read state a crash can destroy — a listening socket, and
  // our own lockfile. Seen live on 2026-08-20: a postmaster alive with neither,
  // still holding the shared-memory block, so `up` sailed past this pre-flight
  // and died on the opaque FATAL while reporting no orphan at all. The process
  // table is the one thing that cannot be erased by whatever killed it.
  // Every CONFIRMED postgres pid joins the list, not just when the two probes
  // above came up empty. Guarding this on "no postgres orphan yet" meant that a
  // postmaster found by its port or its lockfile brought none of its workers
  // with it: a worker surviving the stop was then neither killed nor checked,
  // while "Orphans cleaned up" was printed because no port was left held
  // (pass-6 finding R2).
  for (const pid of ownedPgPids) {
    if (orphans.some((o) => o.pid === pid)) continue;
    orphans.push({ name: 'postgres', port: measuredPort(pid, listeners), pid });
  }

  if (orphans.length > 0) {
    console.log(
      chalk.yellow(
        `Found ${orphans.length} orphan process${orphans.length === 1 ? '' : 'es'} on configured ports:`,
      ),
    );
    for (const o of orphans) {
      console.log(
        chalk.gray(
          o.port === null
            ? `  - ${o.name} for our data dir (pid ${o.pid}, listening on none of our ports)`
            : `  - ${o.name} on :${o.port} (pid ${o.pid})`,
        ),
      );
    }
    console.log(chalk.yellow('Cleaning up before starting…'));

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
    // EVERY postgres orphan, not just the first (finding C7). The report listed
    // them all, then `find` stopped one and the loop below skipped the rest by
    // name: a postmaster could stay alive while `up` announced "Orphans cleaned
    // up" and started a second server on the same data dir.
    const pgOrphans = orphans.filter((o) => o.name === 'postgres');
    // The graceful stop goes through the pid we DECIDED — `stopOrphanPostgres`
    // refuses when the lockfile names anything else, because `pg_ctl` would
    // signal that other pid instead of ours. When it refuses, or fails, the
    // loop below stops each pid itself; the shared-memory section is then left
    // to the postmaster's own exit, which is the risk we take knowingly rather
    // than signalling a process we did not identify.
    //
    // Ownership is re-read RIGHT HERE too, not just before the kills below
    // (pass-9 finding R1): the set was decided back at the port pre-flight, and
    // a postmaster that died in between can have left its pid to a stranger
    // whose number the stale lockfile still matches. `stopOrphanPostgres`
    // compares pids, not processes, so without this the graceful stop was the
    // one step no fresh confirmation covered.
    const postmasterPid = pgOrphans[0]?.pid;
    if (postmasterPid !== undefined) {
      const confirmedNow = new Set<number>((await postgresProcessesForDataDir()).owned);
      if (confirmedNow.has(postmasterPid)) await stopOrphanPostgres(postmasterPid);
    }
    // The set was decided BEFORE the graceful stop. A pid freed by that stop and
    // handed to a stranger would pass `isPidAlive` and take the SIGKILL below,
    // so ownership is asked again — and asked PER PID, immediately before each
    // one is signalled, not once for the whole loop. Waiting for one candidate
    // can take five seconds, and a pid can turn over in that time (pass-5
    // finding R2). The window cannot be closed entirely without holding an OS
    // handle; this shrinks it to the syscall.
    // Anything we declined to touch: the closing line must not claim it was
    // cleaned up (pass-7 finding R2).
    const leftAlone: number[] = [];
    /** Non-postgres pids we declined to signal, for the closing line below. */
    const unconfirmed: number[] = [];
    for (const pgOrphan of pgOrphans) {
      const stillOurs = new Set<number>((await postgresProcessesForDataDir()).owned);
      if (!stillOurs.has(pgOrphan.pid)) {
        // A pid drops out of the owned set by DYING, which is exactly what a
        // successful graceful stop does. Counting those as "left running" told
        // the user a dead process was still there (pass-8 finding R3 — claimed
        // fixed then, and it was not: the edit was lost and the commit message
        // said otherwise. Pass 9 caught the claim).
        if (!isPidAlive(pgOrphan.pid)) continue;
        leftAlone.push(pgOrphan.pid);
        console.log(
          chalk.yellow(
            `  - postgres pid ${pgOrphan.pid} is alive but can no longer be confirmed as ours; it was NOT stopped`,
          ),
        );
        continue;
      }
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

    // The non-postgres orphans. `name` here is the CONFIGURED PORT this pid was
    // found on — "runner", "web" — never what the pid actually is, and until
    // #100 nothing else was asked either. A pid recorded as our runner and
    // recycled onto somebody's Postgres passed `ourPids`, never met
    // `ownedPgPids`, and took a `taskkill /T` that emptied its whole tree.
    //
    // So each root is re-confirmed against a FRESH reading — recorded creation
    // tick and executable name, from `recordServiceTree` — immediately before
    // it is signalled, and the tree kill itself now refuses to walk through a
    // foreign Postgres (see `killPidTree`).
    //
    // Only where a process table EXISTS, which is Windows. Elsewhere there is
    // nothing to confirm against, and refusing every kill on a machine that was
    // never going to answer would break `up`'s own recovery to close a hole
    // that only bites where pids are recycled aggressively. The kill there is
    // the same one as before, with the same reach as before.
    //
    // ONE reading, the one each orphan is confirmed on AND killed on (#1046):
    // `killPidTree` used to read the table again with a shorter budget, and a
    // second look that timed out refused a pid this one had just identified.
    // An earlier kill strikes the pids it signalled from it, so a later orphan
    // is never confirmed on a row whose number may have been freed since.
    const tableAvailable = process.platform === 'win32';
    const reading = tableAvailable ? await ProcessReading.take() : ProcessReading.of(new Map());
    for (const o of orphans) {
      if (o.name === 'postgres') continue; // already handled above
      // After an earlier orphan's kill, one fresh look first (rule 4 of
      // `ProcessReading`); `killPidTree` judges on the same look.
      await reading.lookBeforeJudgingRoot();
      const live = reading.get(o.pid);
      const verdict = !tableAvailable
        ? ({ killable: true } as const)
        : confirmRecordedPid({
            recorded: recordedRoot(known, o.pid),
            live:
              live === undefined
                ? undefined
                : { pid: live.pid, startedAt: live.startedAt, name: live.name ?? '' },
            tableRead: reading.answered,
            ownedPostgresPids: ownedPgPids,
          });
      if (!verdict.killable) {
        if (verdict.code !== 'PID_GONE') {
          unconfirmed.push(o.pid);
          console.log(chalk.yellow(`  - ${o.name} pid ${o.pid} was NOT killed: ${verdict.detail}`));
          process.stderr.write(`${formatRefusal(verdict)}\n`);
        }
        continue;
      }
      try {
        if (process.platform === 'win32') {
          // The tree, but a JUDGED tree: `killPidTree` drops `/T` when it finds
          // a postgres in there that our data dir does not claim, and refuses
          // the root outright when the reading disowns it.
          await killPidTree(o.pid, ownedPgPids, { recorded: recordedRoot(known, o.pid), reading });
        } else {
          // SAID, not implied: nothing here confirmed what this pid now is, and
          // it is about to be killed anyway. Same sentence as `down` prints in
          // the same situation — one wording for one fact.
          console.log(chalk.gray(`  - ${unconfirmedIdentityNotice(o.name, o.pid)}`));
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
        // Nothing to wait for when no port was ever measured for this pid.
        if (o.port === null) continue;
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
      // Both things can be true at once, and this branch used to swallow the
      // second one (pass-8 finding R3).
      const alsoLeft = [...leftAlone, ...unconfirmed];
      if (alsoLeft.length > 0) {
        console.log(
          chalk.yellow(`Also left running, unconfirmed as ours: ${alsoLeft.join(', ')}.`),
        );
      }
      console.log(chalk.gray('Will rotate to free neighbours below.\n'));
    } else if (leftAlone.length > 0 || unconfirmed.length > 0) {
      // "Orphans cleaned up" used to print here whatever we had declined to
      // touch, because the check was "no port still held" — and a surviving
      // worker holds no port (pass-7 finding R2). Say what was actually done.
      //
      // Since #100 the same applies to a NON-postgres recorded pid whose
      // identity a fresh reading could not confirm: it was not killed either,
      // and "Orphans cleaned up" must not cover it.
      if (leftAlone.length > 0) {
        console.log(
          chalk.yellow(
            `Ports are free, but ${leftAlone.length} postgres process(es) were left running ` +
              `(${leftAlone.join(', ')}): they could not be confirmed as ours.\n`,
          ),
        );
      }
      if (unconfirmed.length > 0) {
        console.log(
          chalk.yellow(
            `${unconfirmed.length} recorded process(es) were left running ` +
              `(${unconfirmed.join(', ')}): the pid no longer identifies what we started.\n`,
          ),
        );
      }
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

  // One decision over the three ports (allocateServicePorts): a port another
  // service of this configuration holds or was just given is never handed out.
  const allocation = await allocateServicePorts(config.ports);
  const portChanges: PortRotation[] = [];
  for (const { name, from: configured, to } of allocation.moved) {
    // WHO still holds it. Asked here, at the moment of the move, because this
    // is the only place that knows the port is being abandoned — and after a
    // hard Ctrl+C with an unreadable process table, the answer is a pid we
    // declined to kill and would otherwise never have mentioned again.
    portChanges.push({
      name,
      from: configured,
      to,
      heldBy: await pidListeningOnPort(configured),
    });
  }
  config = { ...config, ports: { ...config.ports, ...allocation.ports } };

  if (portChanges.length > 0) {
    console.log(chalk.yellow('Configured ports unavailable — rotating:'));
    for (const line of formatPortRotation(portChanges)) {
      console.log(line.trimStart().startsWith('-') ? chalk.gray(line) : chalk.yellow(line));
    }
    writeConfig(config);
    console.log(chalk.gray(`  Updated ${CONFIG_FILE}.\n`));
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

  // SECRET-003 (audit 2026-08-07). The embedded cluster used to be reachable on
  // a predictable port with `nodalai`/`nodalai` — the same on every install — so
  // any local process could read the whole database (transcripts, memory,
  // connector tokens) without touching the file ACLs that protect secrets.key.
  //
  // A cluster created before this field exists still carries the old password:
  // initdb sets it once, so the fix has to go through ALTER USER on a running
  // server. A change is recorded as `postgresPasswordPending` BEFORE it is made
  // and confirmed only once the database took it, so a start cut in the middle
  // loses neither value (lib/pg-password.ts).
  const pgPort = config.ports.postgres;
  const pgSpinner = ora('Starting embedded Postgres…').start();
  let started: PasswordStart<Awaited<ReturnType<typeof startEmbeddedPostgres>>>;
  try {
    started = await startWithPassword(config, {
      // `--detach`: the cluster must outlive this launcher, so it is spawned
      // detached and released from the package's stop-at-exit just before the
      // exit below (#835). A foreground `up` keeps both: Ctrl+C stops everything.
      start: (password) =>
        startEmbeddedPostgres(undefined, pgPort, password, undefined, {
          detached: opts.detach === true,
        }),
      save: (next) => writeConfig(next),
      mint: () => randomBytes(24).toString('base64url'),
    });
    pgSpinner.succeed(chalk.green(`Postgres ready on port ${config.ports.postgres}`));
  } catch (err) {
    pgSpinner.fail('Failed to start Postgres');
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
  config = started.config;
  const pg = started.pg;

  // ── 2b. Shutdown handlers — registered HERE, not at the end ───────────────
  // The moment Postgres is up there is something that must be torn down on
  // Ctrl+C, and from here to the ready message there is a lot of waiting:
  // migrations, seed, and above all the health wait, whose budget is FIVE
  // MINUTES. These handlers used to be registered after all of it, so a Ctrl+C
  // during that window killed the CLI and left the postmaster running — with
  // its shared-memory section attached to the data dir, which is what makes the
  // next `up` fail on FATAL "pre-existing shared memory block is still in use".
  // The one window that is genuinely impatient is therefore the one that had no
  // handler at all.
  let shuttingDown = false;
  const running: { runner: SpawnResult | null; web: SpawnResult | null } = {
    runner: null,
    web: null,
  };

  /** Tear down whatever is up, in reverse order of start. Idempotent. */
  const shutdown = async (cause = 'signal'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Written BEFORE the teardown, not after: a shutdown that hangs or is
    // itself killed must still have said why it started (issue #111, point 3).
    logLauncherEvent('shutdown', `cause=${cause}`);
    console.log('\n' + chalk.yellow('  Stopping Nodal-Agents…'));
    // Read the tree BEFORE killing: clearPids() wipes it at the end, and on
    // Ctrl+C the live parent/child links are already collapsing (see
    // recordServiceTree for the full account).
    // An unreadable record must not stop the teardown halfway (the database
    // would stay up): it is said, and what this process holds is still stopped.
    let recorded: ProcessRecord[] = [];
    try {
      recorded = readPids()?.children ?? [];
    } catch (err) {
      console.error(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
    }
    await Promise.allSettled(
      [running.runner, running.web].filter((c): c is SpawnResult => c !== null).map(killSilent),
    );
    // Whatever the tree walk could no longer reach — in dev that is the Next
    // server behind the `next dev` launcher, which outlives its own parent.
    const swept = await sweepRecordedChildren(recorded);
    if (swept.length > 0) {
      console.log(chalk.gray(`  Also stopped ${swept.length} background worker(s) they had left`));
    }
    // Graceful, always: pg.stop() runs `pg_ctl stop -m fast`, which releases the
    // Win32 shared-memory section. A hard kill here would leak it.
    await pg.stop();
    clearPids();
    console.log(chalk.green('  Stopped. Goodbye!'));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // After the handlers, so a Ctrl+C during the ALTER still stops the cluster.
  // Not fatal when the ALTER fails: the install keeps working on the previous
  // password and the recorded change runs again next start. Loud rather than
  // silent (invariant #4).
  const finished = await finishPasswordChange(started, {
    save: (next) => writeConfig(next),
    warn: (message) => console.warn(chalk.yellow(message.replace(/^/gm, '  '))),
  });
  config = finished.config;
  const effectivePgPassword = finished.password;

  const databaseUrl = buildDatabaseUrl(config.ports.postgres, effectivePgPassword);

  // ── 3. The schema: one function decides, for every way `up` is started ─────
  //
  // `migrateDatabase` (@nodal-agents/db/safe-migrate) is the only path that
  // moves the schema, here and with `--repair-migrations`, `--dev`, and the
  // restart `update` launches. In order: a database newer than this program
  // is refused; a migration the migrator skipped (#298) is refused unless
  // repair is asked; when the schema is about to move over rows, a copy is
  // taken first inside the cluster with config.json and secrets.key beside it,
  // and when that copy cannot be made NOTHING is migrated (invariant #4);
  // then the migrations, the repair, a second reading, and the version that
  // opened the database is recorded.
  const schemaSpinner = ora('Checking the database schema…').start();
  const programVersion = getInstalledVersion();
  try {
    const result = await migrateDatabase(databaseUrl, {
      patchVectorAsText: !pg.vectorAvailable,
      repair: opts.repairMigrations === true,
      programVersion,
      keep: config.snapshots?.keep ?? DEFAULT_SNAPSHOTS_KEPT,
      // The volume the cluster writes the copy to: its data directory's.
      freeBytes: () => {
        const fs = statfsSync(PG_DATA_DIR);
        return Number(fs.bavail) * Number(fs.bsize);
      },
      stateFiles: homeStateFiles(),
      onStep: (text) => {
        schemaSpinner.text = text;
      },
    });
    const said: string[] = [];
    if (result.snapshot) {
      said.push(
        `copy ${result.snapshot.name} (${formatBytes(result.snapshot.sizeBytes)}) taken first`,
      );
    }
    if (result.applied.length > 0) {
      said.push(
        `${result.applied.length} migration${result.applied.length === 1 ? '' : 's'} applied`,
      );
    }
    if (result.repaired.length > 0) said.push(`repaired: ${result.repaired.join(', ')}`);
    schemaSpinner.succeed(
      chalk.green(
        said.length > 0 ? `Database schema: ${said.join('; ')}` : 'Database schema up to date',
      ),
    );
    if (result.unclaimed.length > 0) {
      console.log(chalk.yellow(`  ${unclaimedHistoryNotice(result.unclaimed)}`));
    }
    if (result.pruned.length > 0) {
      console.log(
        chalk.gray(
          `  Older copies removed (keeping ${config.snapshots?.keep ?? DEFAULT_SNAPSHOTS_KEPT}): ${result.pruned.join(', ')}`,
        ),
      );
    }
  } catch (err) {
    await pg.stop();
    if (err instanceof DatabaseNewerThanProgramError) {
      schemaSpinner.fail('This database is newer than this program');
      throw new Error(databaseNewerRefusal(err, programVersion), { cause: err });
    }
    if (err instanceof MigrationGapError) {
      schemaSpinner.fail(
        `${err.gaps.length} migration${err.gaps.length === 1 ? '' : 's'} in the journal never reached this database`,
      );
      throw new Error(
        migrationGapRefusal(err.gaps, { dev: opts.dev === true, detach: opts.detach === true }),
        { cause: err },
      );
    }
    if (err instanceof SnapshotError) {
      schemaSpinner.fail('No copy of the database could be made: nothing was migrated');
      throw new Error(snapshotRefusal(err), { cause: err });
    }
    if (err instanceof MigrationFailedError) {
      schemaSpinner.fail('Migration failed');
      throw new Error(migrationFailure(errorChain(err.cause), err.snapshot), { cause: err });
    }
    schemaSpinner.fail('Could not check the database schema');
    throw err;
  }

  // ── 3.5 Master-key sanity check (I-6) ─────────────────────────────────────
  // Before anything touches encrypted rows: if ~/.nodalai/secrets.key is
  // missing but the DB already has credentials / LLM keys encrypted with it,
  // fail loud instead of letting the runner silently mint a replacement key
  // (which would make all of that data permanently undecryptable). Runs here
  // — earliest point where both the config dir and the DB are available —
  // and BEFORE the seed step below or the runner boot (migrateLlmKeysToEncrypted
  // also calls loadOrCreateMasterKey, but by then it'd be too late to warn).

  {
    const { db, close } = createClient(databaseUrl, { max: 1 });
    try {
      await assertMasterKeyRestorable(db);
    } catch (err) {
      await close();
      await pg.stop();
      throw err;
    }
    await close();
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
  const runnerProcess = spawnRunner(runnerEnv, { detach: opts.detach });
  running.runner = runnerProcess;
  const runnerPid = runnerProcess.pid ?? 0;
  runnerSpinner.succeed(chalk.green(`Runner started (pid ${runnerPid})`));

  // ── 6. Spawn web ──────────────────────────────────────────────────────────

  const webEnv = buildEnvForWeb(config, databaseUrl);
  const webSpinnerLabel = opts.dev ? 'Starting web (dev — HMR)…' : 'Starting web…';
  const webSpinner = ora(webSpinnerLabel).start();
  const webProcess = spawnWeb(webEnv, { dev: opts.dev, detach: opts.detach });
  running.web = webProcess;
  const webPid = webProcess.pid ?? 0;
  webSpinner.succeed(chalk.green(`Web started (pid ${webPid})`));

  // Said once per pid, however many times the record is refreshed. Off Windows
  // there is no process table, so there is nothing to identify with and nothing
  // to report: `down` states that itself when it acts.
  const noted = new Set<number>();
  const reportUnidentified = (outcome: RecordOutcome): void => {
    for (const pid of outcome.unidentified) {
      if (noted.has(pid)) continue;
      noted.add(pid);
      const label = pid === runnerPid ? 'runner' : 'web';
      console.log(
        chalk.yellow(
          `  ${label} (pid ${pid}) could not be identified in the process table: it is on record ` +
            'as a bare number,\n' +
            '    and `nodal-agents down` will refuse to stop a pid nothing identifies.',
        ),
      );
    }
  };

  // Save PIDs for `nodal-agents down` — WITH their identity, now, not after the
  // health check: `down` may be run the moment the web answers, and a pid on
  // record without its creation tick is one it refuses to stop (#767). The same
  // writer runs again once the tree is formed.
  reportUnidentified(await recordServiceTree({ runner: runnerPid, web: webPid }));

  // ── 7. Wait for health ────────────────────────────────────────────────────

  const healthSpinner = ora('Waiting for services to be healthy…').start();
  // First run on a CLEAN machine is heavy and slow, and this is where a too-tight
  // budget bites hardest: the first boot runs initdb on a cold disk (the ~70MB
  // of Postgres binaries SHIP inside @embedded-postgres/<platform>, they are
  // not fetched at runtime — checked in 18.3.0-beta.17, whose install script
  // only rehydrates symlinks; see lib/embedded-postgres-binaries.ts and #247),
  // the runner loads a large module graph (googleapis et al.) off a cold disk
  // cache, and seeds 19
  // system skills — all before it answers /api/health. On a warm machine this is
  // quick (<20s); on a fresh install it routinely blows past a minute, which is
  // exactly what tore the stack down for fresh installers (runner "did not become
  // healthy within 60000ms"). `next dev`/`next start` first-compile is similarly
  // slow from a cold cache. So the cold-start budget is generous — 5 minutes —
  // and env-overridable for very slow disks/connections.
  const webHealthMs = Number(process.env['NODALAI_WEB_HEALTH_MS']) || 300_000;
  const runnerHealthMs = Number(process.env['NODALAI_RUNNER_HEALTH_MS']) || 300_000;

  // A five-minute budget behind a spinner that only ever says "Waiting for
  // services to be healthy…" is indistinguishable from a hang, and it hides the
  // one fact that identifies the fault: WHICH service never answered. Track
  // each one, name what is still outstanding, and count the seconds.
  const pending = new Set(['runner', 'web']);
  const startedAt = Date.now();
  const describeWait = (): string => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const budget = Math.round(Math.max(runnerHealthMs, webHealthMs) / 1000);
    return `Waiting for ${[...pending].join(' + ')} — ${secs}s of ${budget}s`;
  };
  const ticker = setInterval(() => {
    healthSpinner.text = describeWait();
  }, 1000);
  // A stray interval would keep the event loop alive and hold the terminal
  // after everything else is done.
  ticker.unref?.();

  try {
    await Promise.all([
      waitForHealth(runnerUrl, runnerHealthMs).then(() => {
        pending.delete('runner');
      }),
      waitForHealth(webUrl, webHealthMs).then(() => {
        pending.delete('web');
      }),
    ]);
    // /api/health alone is NOT proof the dashboard renders — see
    // assertWebRenders' doc (0.7.8 ritual: every page 500'd on a missing
    // standalone dependency while both health endpoints stayed green).
    // Same generous budget as the health wait above — dev's first Turbopack
    // compile of `/` can take minutes on a cold cache (see assertWebRenders).
    pending.add('web page render');
    healthSpinner.text = describeWait();
    await assertWebRenders(webUrl, webHealthMs);
    pending.delete('web page render');
    clearInterval(ticker);
    healthSpinner.succeed(chalk.green('All services healthy'));

    // Everything is up and the process tree is fully formed — the only moment
    // where it can be read reliably. Ctrl+C tears the links down faster than a
    // shutdown handler can walk them (see recordServiceTree).
    reportUnidentified(await recordServiceTree({ runner: runnerPid, web: webPid }));
  } catch (err) {
    clearInterval(ticker);
    healthSpinner.fail(
      `Health check timed out — still waiting for ${[...pending].join(' + ')} after ` +
        `${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
    // The answer is almost always in the failing service's own log, and until
    // now the user was never told it existed. On 2026-08-20 the log said
    // "TypeError: Cannot read properties of undefined (reading 'validationLevel')"
    // — the exact root cause — while the CLI only reported a timeout, sending
    // the diagnosis off after Postgres instead.
    for (const svc of pending) {
      const name = svc === 'web page render' ? 'web' : svc;
      printLogTail(name, 20);
    }
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
      const { getLatestVersion, isNewerVersion } = await import('../lib/version.ts');
      const installed = programVersion;
      // Timeout already capped inside getLatestVersion() at 5 s; we add an
      // outer race of 3 s here so any internal delay can't push the notice
      // after the ready block.
      const latest = await Promise.race([
        getLatestVersion(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
      ]);
      // Strictly newer only — a `!==` check also fires (and would send the
      // user toward `update`, i.e. a downgrade) when `latest` is OLDER, e.g. a
      // lagging registry mirror.
      if (latest !== null && isNewerVersion(latest, installed)) {
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
  logLauncherEvent(
    'started',
    `web=${webUrl} runner=${runnerUrl} mode=${opts.detach ? 'detached' : 'foreground'}`,
  );
  console.log(chalk.bold.green(`  Nodal-Agents ready at ${webUrl}`));
  if (config.bind === 'lan') {
    console.log(chalk.cyan(`  LAN mode — sign up at ${webUrl}/login`));
  }

  // ── 9a. The page renderer, downloaded once (#1082) ───────────────────────
  // AFTER "All services healthy" and the ready line, never before: the
  // download cannot delay the start. It never fails it either: a failure is
  // said here and by render_pdf, with the command to install it later.
  // Foreground: it runs while the services serve. Detached: the prompt comes
  // back once it is done, so the progress is seen and nothing is cut halfway.
  const { ensureRendererAtStart, rendererInstallTurnedOff } =
    await import('../lib/page-renderer.ts');
  const rendererStart = ensureRendererAtStart({
    turnedOff: rendererInstallTurnedOff(config, opts.skipRendererInstall === true),
  }).then((outcome) => {
    logLauncherEvent('page-renderer', `outcome=${outcome}`);
  });

  // ── 9b. Detached: hand the terminal back and leave everything running ─────
  // The order matters. We return only AFTER the health + render checks above,
  // so a detached start that comes back to the prompt is a start that WORKED —
  // the failure path further up already tore the children down and threw.
  //
  // And we return BEFORE registering the shutdown handlers below: those exist
  // to kill the services when the foreground CLI dies, which is precisely what
  // must not happen here.
  if (opts.detach) {
    await rendererStart;
    logLauncherEvent('detached', `web=${webUrl} runner=${runnerUrl}`);
    console.log(chalk.gray('  Detached — the terminal is yours again.'));
    console.log(chalk.gray('  nodal-agents logs runner   follow a service'));
    console.log(chalk.gray('  nodal-agents down          stop everything'));
    // Said here because this is the last thing the user sees before the
    // terminal is theirs again — and after that, this file is the only place
    // the launcher can still tell them anything (issue #111, point 3).
    console.log(chalk.gray(`  ${LAUNCHER_LOG}   what the launcher saw`));
    console.log('');
    // The runner and the web were spawned detached and unref'd. Postgres was
    // spawned detached too, but it is a CHILD of this launcher — not a pg_ctl
    // daemon — and `embedded-postgres` stops every cluster it started when the
    // process exits, so it is released from that hook here; `nodal-agents down`
    // stops it by its data directory afterwards (#835). Nothing else holds the
    // loop except the fire-and-forget version check above, whose 3s timer would
    // otherwise sit between the user and the prompt.
    pg.outliveLauncher();
    process.exit(0);
  }

  console.log(chalk.gray('  Ctrl+C to stop all services'));
  console.log('');

  // ── 9c. Health watchdog — the launcher keeps LOOKING after the boot ───────
  // Constat du 23/08 : Postgres est mort sous une stack déclarée « healthy ».
  // Le Promise.race du bas n'attend que la mort des processus runner/web — un
  // Postgres mort ne tue ni l'un ni l'autre, donc rien ne le voyait. Le runner
  // sonde sa base à chaque GET /api/health (503 si morte) : on ré-interroge CE
  // health toutes les 30s et on nomme la panne dans le terminal, une fois par
  // transition. Pas de redémarrage automatique (invariant #4 — fail loud).
  // Foreground uniquement : en --detach le lanceur est déjà sorti, la vérité
  // vit alors dans /api/health (runner ET web pingent la base désormais).
  const watchdog: Watchdog = startHealthWatchdog({
    probe: () => probeRunnerHealth(runnerUrl),
    onTransition: (state, detail) => {
      const at = new Date().toLocaleTimeString();
      // The terminal gets local time for whoever is watching; the file gets a
      // UTC instant, because on 2026-09-15 nobody was watching and the terminal
      // was the only place this had ever been said.
      logLauncherEvent(state === 'healthy' ? 'recovered' : 'degraded', `state=${state} ${detail}`);
      if (state === 'healthy') {
        console.log(chalk.green(`\n  [${at}] Recovered — ${detail}.`));
        return;
      }
      console.error(chalk.red.bold(`\n  [${at}] DEGRADED — ${detail}.`));
      if (state === 'degraded') {
        console.error(
          chalk.red(
            '  The dashboard may still render, but nothing can read or write the database:\n' +
              '  jobs are not created, chats and schedules are failing.',
          ),
        );
        printLogTail('runner', 10);
      }
      console.error(
        chalk.yellow('  → Restart the stack: `nodal-agents down`, then `nodal-agents up`.'),
      );
    },
  });

  // ── 10. Stay up until a child exits ───────────────────────────────────────
  // SIGINT/SIGTERM are already handled — the handlers were registered back at
  // step 2b, as soon as Postgres came up, so the whole startup window is
  // covered and not just this point onwards.

  // Keep process alive until a child exits, then shut down
  // WHICH child exited is the question `%TEMP%\nodal-dev.log` could not answer
  // on 2026-09-15: the launcher said "Stopped. Goodbye!" and nothing else.
  const exited = await Promise.race([
    runnerProcess.then(() => 'runner' as const).catch(() => 'runner' as const),
    webProcess.then(() => 'web' as const).catch(() => 'web' as const),
  ]);
  logLauncherEvent('child-exited', `service=${exited}`);

  watchdog.stop();
  await shutdown(`${exited} exited`);
}
