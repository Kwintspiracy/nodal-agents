#!/usr/bin/env node
// index.ts — nodal-agents CLI entry point
// Registered as `nodal-agents` binary in package.json bin field.

import { Command } from 'commander';
import chalk from 'chalk';
import { getInstalledVersion } from './lib/version.ts';

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
  .action(async (opts: { dev?: boolean; detach?: boolean }) => {
    const { runUp } = await import('./commands/up.ts');
    try {
      await runUp({ dev: opts.dev, detach: opts.detach });
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodal-agentsinit ──────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Interactive wizard — configure LLM, ports, and bind mode')
  .option('--force', 'Overwrite existing config without confirmation')
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
  .action(async (opts: { dev?: boolean; detach?: boolean }) => {
    const { runUp } = await import('./commands/up.ts');
    try {
      await runUp({ dev: opts.dev, detach: opts.detach });
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
      await runDown();
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
    'Start the stdio MCP server (use via: claude mcp add nodal -- nodal-agents mcp serve)',
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
