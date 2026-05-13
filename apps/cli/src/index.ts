#!/usr/bin/env node
// index.ts — nodal-agents CLI entry point
// Registered as `nodal-agents` binary in package.json bin field.

import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

program
  .name('nodal-agents')
  .description('Local AI agent platform — one command to start everything')
  .version('0.0.0')
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
  .action(async (opts: { dev?: boolean }) => {
    const { runUp } = await import('./commands/up.ts');
    try {
      await runUp({ dev: opts.dev });
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
  .action(async (opts: { dev?: boolean }) => {
    const { runUp } = await import('./commands/up.ts');
    try {
      await runUp({ dev: opts.dev });
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

// ─────────────────────────────────────────────────────────────────────────────

program.parse(process.argv);
