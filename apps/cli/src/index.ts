#!/usr/bin/env node
// index.ts — @nodalai/cli entry point
// Registered as `nodalai` binary in package.json bin field.

import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

program
  .name('nodalai')
  .description('Local AI agent platform — one command to start everything')
  .version('0.0.0');

// ── nodalai (default: up) ─────────────────────────────────────────────────────

program.action(async () => {
  const { runUp } = await import('./commands/up.ts');
  try {
    await runUp();
  } catch (err) {
    console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
});

// ── nodalai init ──────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Interactive wizard — configure LLM, ports, and bind mode')
  .option('--force', 'Overwrite existing config without confirmation')
  .action(async (opts: { force?: boolean }) => {
    const { runInit } = await import('./commands/init.ts');
    try {
      await runInit({ force: opts.force });
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodalai up ────────────────────────────────────────────────────────────────

program
  .command('up')
  .description('Start Postgres, runner, and web — open browser when ready')
  .action(async () => {
    const { runUp } = await import('./commands/up.ts');
    try {
      await runUp();
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodalai down ─────────────────────────────────────────────────────────────

program
  .command('down')
  .description('Stop all running NodalAI processes')
  .action(async () => {
    const { runDown } = await import('./commands/down.ts');
    try {
      await runDown();
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── nodalai logs ──────────────────────────────────────────────────────────────

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

// ── nodalai reset ─────────────────────────────────────────────────────────────

program
  .command('reset')
  .description('Delete all NodalAI data and config')
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
