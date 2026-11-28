#!/usr/bin/env node
// index.ts — nodal-agents CLI entry point
// Registered as `nodal-agents` binary in package.json bin field.

import '@nodal-agents/shared/node-guard';
import { Command } from 'commander';
import chalk from 'chalk';
import { assertNodalHomeSettings } from '@nodal-agents/shared/nodal-home';
import { getInstalledVersion } from './lib/version.ts';
import { DEFAULT_SNAPSHOTS_KEPT } from '@nodal-agents/shared/nodal-config';

// NODALAI_HOME (ou une variable plus étroite, NODALAI_CONFIG_PATH…) vide ou
// relative : refusée ICI, avant toute commande, avec le message seul. Chaque
// commande charge config.ts, qui la relit ; sans cette garde, le refus
// sortirait en pile d'appels du premier import.
try {
  assertNodalHomeSettings();
} catch (err) {
  console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const program = new Command();

program
  .name('nodal-agents')
  .description('Local AI agent platform — one command to start everything')
  .version(getInstalledVersion())
  // Without this, options registered both at program-level (e.g. --dev for the
  // default action) and at subcommand-level (e.g. up --dev) collide: commander
  // greedily consumes the flag at the program level, so `nodal-agents up --dev`
  // silently runs `up` with opts={}. enablePositionalOptions tells commander
  // that anything after a positional argument (the subcommand name) belongs
  // to the subcommand. See regression test in apps/cli/tests/dev-flag.test.ts.
  .enablePositionalOptions();

// ── nodal-agents (default: up) ────────────────────────────────────────────────

program
  .option('--dev', 'Run web in `next dev` mode (HMR, no prebuild required)')
  .option('-d, --detach', 'Return to the prompt once healthy — services keep running')
  .option(
    '--skip-renderer-install',
    'Do not download the page renderer at this start (render_pdf then says it is not installed)',
  )
  .action(async (opts: { dev?: boolean; detach?: boolean; skipRendererInstall?: boolean }) => {
    const { runUp } = await import('./commands/up.ts');
    try {
      await runUp({
        dev: opts.dev,
        detach: opts.detach,
        skipRendererInstall: opts.skipRendererInstall,
      });
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agentsinit ──────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Interactive wizard — configure LLM, ports, and bind mode')
  .option(
    '--force',
    'Change an existing config without confirmation (it is edited, never replaced)',
  )
  .option(
    '--non-interactive',
    'Write a default config without prompting (used by container entrypoints)',
  )
  .action(async (opts: { force?: boolean; nonInteractive?: boolean }) => {
    const { runInit } = await import('./commands/init.ts');
    try {
      await runInit({ force: opts.force, nonInteractive: opts.nonInteractive });
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agentsup ────────────────────────────────────────────────────────────────

program
  .command('up')
  .description('Start Postgres, runner, and web — open browser when ready')
  .option('--dev', 'Run web in `next dev` mode (HMR, no prebuild required)')
  .option('-d, --detach', 'Return to the prompt once healthy — services keep running')
  // Le geste de réparation vit sur `up` et non dans une commande à lui : il
  // demande le Postgres embarqué DÉJÀ démarré, et `up` est le seul endroit du
  // CLI qui le démarre (issue #298).
  .option(
    '--repair-migrations',
    'Apply migrations the journal announces and this database never got',
  )
  .option(
    '--skip-renderer-install',
    'Do not download the page renderer at this start (render_pdf then says it is not installed)',
  )
  .action(
    async (opts: {
      dev?: boolean;
      detach?: boolean;
      repairMigrations?: boolean;
      skipRendererInstall?: boolean;
    }) => {
      const { runUp } = await import('./commands/up.ts');
      try {
        await runUp({
          dev: opts.dev,
          detach: opts.detach,
          repairMigrations: opts.repairMigrations,
          skipRendererInstall: opts.skipRendererInstall,
        });
      } catch (err) {
        console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );

// ── nodal-agents renderer ─────────────────────────────────────────────────────
//
// Le moteur de rendu de pages (#1082) : `up` le télécharge une fois, après
// « All services healthy ». Cette commande l'installe au premier plan (refusé
// au démarrage, ou échoué hors ligne), ou dit où il en est.

const renderer = program
  .command('renderer')
  .description("Nodal's page renderer (the window-less Chrome that render_pdf drives)");

renderer
  .command('install')
  .description('Download and install the pinned page renderer now, showing progress')
  .action(async () => {
    const { runRendererInstall } = await import('./lib/page-renderer.ts');
    try {
      process.exitCode = await runRendererInstall();
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

renderer
  .command('status')
  .description('Say whether the page renderer is installed, and why not')
  .action(async () => {
    const { runRendererStatus } = await import('./lib/page-renderer.ts');
    try {
      process.exitCode = await runRendererStatus();
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agentsdown ─────────────────────────────────────────────────────────────

program
  .command('down')
  .description('Stop all running Nodal-Agents processes')
  .action(async () => {
    const { runDown } = await import('./commands/down.ts');
    try {
      const { unstopped } = await runDown();
      // Something is still running: the summary said what, the exit code says it
      // to scripts. A `down` that returned 0 here was the lie of #767.
      if (unstopped.length > 0) process.exit(1);
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agents service ──────────────────────────────────────────────────────
//
// #451 — start Nodal with the machine, through its native startup manager
// (the per-user Run key on Windows, LaunchAgent, systemd user unit). `--json` is what the
// dashboard's Settings switch reads.

program
  .command('service <action>')
  .description('Start Nodal when this machine starts: install | uninstall | status')
  .option('--json', 'Print the state as JSON (used by the dashboard)')
  .action(async (action: string, opts: { json?: boolean }) => {
    if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
      console.error(
        chalk.red('Error:'),
        `unknown action "${action}" (install | uninstall | status)`,
      );
      process.exit(1);
    }
    const { runService } = await import('./commands/service.ts');
    try {
      await runService(action, opts);
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agents open ─────────────────────────────────────────────────────────
//
// In the mode with no password, a browser enters the dashboard through a link
// made from the install's secret (lib/dashboard-link.ts). `up` opens one; this
// makes another, for a browser that has not been let in yet.

program
  .command('open')
  .description('Open the dashboard in a browser (prints the one-time link too)')
  .option('--print', 'Only print the link, do not open a browser')
  .action(async (opts: { print?: boolean }) => {
    const { runOpen } = await import('./commands/open.ts');
    try {
      process.exitCode = await runOpen({ print: opts.print });
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agentslogs ──────────────────────────────────────────────────────────────

program
  .command('logs [service]')
  .description('Tail logs for a service (web | runner | postgres). Omit for all.')
  .action(async (service: string | undefined) => {
    const { runLogs } = await import('./commands/logs.ts');
    try {
      await runLogs(service);
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agents rollback ─────────────────────────────────────────────────────
//
// The way back from a migration: `up` copies the database inside its cluster
// before every migration (with config.json and secrets.key beside the copy).
// This lists the copies, or swaps one back in, the current database kept as a
// copy of its own. Refused while Nodal runs.

program
  .command('rollback')
  .description('List the copies of the database taken before migrations, or swap one back in')
  .argument('[snapshot]', 'The copy to swap back in (omit to list them)')
  .addHelpText(
    'after',
    `
A copy is taken before every migration of a database that holds data. Nodal keeps
the last ${DEFAULT_SNAPSHOTS_KEPT} (setting: "snapshots": { "keep": N } in config.json, at least 1);
older ones are dropped only once a new one is complete. Swapping one back keeps
the current database as a copy too: nothing is dropped. Stop Nodal first
(nodal-agents down).`,
  )
  .action(async (snapshot: string | undefined) => {
    const { runRollback } = await import('./commands/rollback.ts');
    try {
      await runRollback(snapshot === undefined ? {} : { name: snapshot });
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agents backup / restore ─────────────────────────────────────────────
//
// One file holding everything this install needs to live again (every table,
// the master key, the config, optionally the workspaces), read back and
// compared with the database before it is called done; and the way back from
// it, on this machine or another. The database a restore replaces is kept as
// a copy `rollback` can swap back.

program
  .command('backup')
  .description('Write everything this install needs into one verified file')
  .option('--to <folder>', 'The folder to write it to (default: the "backups" folder of this home)')
  .option('--with-workspaces', "Include this home's workspaces folder")
  .option(
    '--passphrase',
    'Protect the file with a passphrase you type (or NODALAI_BACKUP_PASSPHRASE)',
  )
  .option(
    '--keep <n>',
    'Keep only the newest N backups of the folder, once this one is verified',
    (v) => Number(v),
  )
  .addHelpText(
    'after',
    `
The file holds the master key: whoever has it can read every stored
credential, unless it was made with --passphrase (a forgotten passphrase
cannot be recovered). The default folder is on the same disk as the install:
copy the file elsewhere to survive the loss of the disk. It works while Nodal
runs (one consistent snapshot) or not.`,
  )
  .action(
    async (opts: {
      to?: string;
      withWorkspaces?: boolean;
      passphrase?: boolean;
      keep?: number;
    }) => {
      const { runBackup } = await import('./commands/backup.ts');
      try {
        await runBackup(opts);
      } catch (err) {
        console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );

program
  .command('restore')
  .description('Bring this install back from a backup file (the replaced database is kept)')
  .argument('<file>', 'The backup file (.nodalbak)')
  .addHelpText(
    'after',
    `
Stop Nodal first (nodal-agents down). The database the backup replaces is kept
as a copy: \`nodal-agents rollback\` lists it and swaps it back. A backup from an
older version is migrated by this one; a backup from a newer version is refused
(install that version first). On a machine with no install yet, one is created
first. The config of the backup comes back, with this machine's ports and
database password.`,
  )
  .action(async (file: string) => {
    const { runRestore } = await import('./commands/restore.ts');
    try {
      await runRestore(file);
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agents checkpoints ──────────────────────────────────────────────────
//
// The other half of the snapshots taken before an agent writes. They are
// invisible to the model on purpose; a net nobody can reach is not a net.
// Restoring stays a human gesture: judging that a run went wrong is a judgement,
// and an agent able to roll itself back could roll back the evidence too.

const checkpoints = program
  .command('checkpoints')
  .description('Snapshots taken before an agent modified a workspace');

checkpoints
  .command('list', { isDefault: true })
  .description('List checkpoints for a workspace (defaults to the current directory)')
  .argument('[workspace]', 'Workspace path')
  .action(async (workspace?: string) => {
    const { runCheckpointsList } = await import('./commands/checkpoints.ts');
    try {
      await runCheckpointsList(workspace);
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

checkpoints
  .command('restore')
  .description('Restore a workspace to a checkpoint (the replaced state is saved first)')
  .argument('<sha>', 'Checkpoint sha, or its first characters')
  .argument('[workspace]', 'Workspace path')
  .action(async (sha: string, workspace?: string) => {
    const { runCheckpointsRestore } = await import('./commands/checkpoints.ts');
    try {
      await runCheckpointsRestore(sha, workspace);
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agents mcp ──────────────────────────────────────────────────────────
//
// STDOUT du sous-processus `serve` = transport JSON-RPC du client MCP. Aucune
// bannière, aucun chalk : toute sortie humaine part sur stderr (voir mcp.ts).

const mcp = program
  .command('mcp')
  .description('Expose this install as an MCP server for external clients');

mcp
  .command('serve')
  .description(
    'Start the stdio MCP server (your MCP client launches it: copy its exact command from Settings → Safety → MCP server)',
  )
  .action(async () => {
    const { runMcpServe } = await import('./commands/mcp.ts');
    try {
      await runMcpServe();
    } catch (err) {
      // stderr uniquement — jamais stdout (transport MCP).
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agentsreset ─────────────────────────────────────────────────────────────

program
  .command('reset')
  .description('Delete all Nodal-Agents data and config')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (opts: { yes?: boolean }) => {
    const { runReset } = await import('./commands/reset.ts');
    try {
      await runReset({ yes: opts.yes });
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agentsupdate ────────────────────────────────────────────────────────

program
  .command('update')
  .description('Update nodal-agents to the latest version and restart the stack')
  .option('--no-restart', 'Install the update but do not restart services automatically')
  .action(async (opts: { restart: boolean }) => {
    const { runUpdate } = await import('./commands/update.ts');
    try {
      await runUpdate({ noRestart: opts.restart === false });
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────

program.parse(process.argv);
