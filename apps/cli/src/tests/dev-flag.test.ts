// dev-flag.test.ts — regression for commander option propagation.
// Without enablePositionalOptions on the program, `nodalai up --dev`
// silently runs `up` with opts={} because the program-level --dev flag
// (registered for the default `nodalai --dev` shortcut) greedily consumes
// the flag. The bug burned 3 days of unknowingly running stale prod builds.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

function buildCli(): {
  program: Command;
  capture: { up: Record<string, unknown> | null; default: Record<string, unknown> | null };
} {
  const capture = {
    up: null as Record<string, unknown> | null,
    default: null as Record<string, unknown> | null,
  };
  const program = new Command();
  program.exitOverride();
  program.enablePositionalOptions();
  program.option('--dev', 'program-level dev').action((opts: Record<string, unknown>) => {
    capture.default = opts;
  });
  program
    .command('up')
    .option('--dev', 'subcommand dev')
    .action((opts: Record<string, unknown>) => {
      capture.up = opts;
    });
  return { program, capture };
}

describe('CLI commander option propagation', () => {
  it('`nodalai up --dev` reaches the up action with opts.dev=true', async () => {
    const { program, capture } = buildCli();
    await program.parseAsync(['node', 'cli.js', 'up', '--dev']);
    expect(capture.up).toEqual({ dev: true });
    expect(capture.default).toBeNull();
  });

  it('`nodalai up` (no flag) reaches the up action with opts={}', async () => {
    const { program, capture } = buildCli();
    await program.parseAsync(['node', 'cli.js', 'up']);
    expect(capture.up).toEqual({});
    expect(capture.default).toBeNull();
  });

  it('`nodalai --dev` (no subcommand) reaches the default action with opts.dev=true', async () => {
    const { program, capture } = buildCli();
    await program.parseAsync(['node', 'cli.js', '--dev']);
    expect(capture.default).toEqual({ dev: true });
    expect(capture.up).toBeNull();
  });
});
