// update.ts — nodal-agents update command.
//
// Sequence:
//  1. Read installed version + fetch latest from npm.
//  2. If already on latest → print notice, return.
//  3. Otherwise: runDown() (best-effort), npm install -g nodal-agents@latest,
//     then optionally restart with a detached `nodal-agents up`.
//
// FAIL LOUD invariant: permission errors and npm-not-found are reported with
// actionable messages and the process exits non-zero. No silent fallbacks.

import chalk from 'chalk';
import { execa } from 'execa';
import { getInstalledVersion, getLatestVersion } from '../lib/version.ts';
import { runDown } from './down.ts';

export interface UpdateOptions {
  /**
   * When true, skip the automatic `nodal-agents up` after the install.
   * The user is told to run it manually.
   */
  noRestart?: boolean;
}

export async function runUpdate(opts: UpdateOptions = {}): Promise<void> {
  // ── 1. Resolve versions ────────────────────────────────────────────────────

  const installed = getInstalledVersion();
  const latest = await getLatestVersion();

  if (latest === null) {
    // Registry unreachable — fail loud: the user should know the check failed
    // rather than silently proceed (invariant #4 — no silent fallbacks).
    console.log(
      chalk.yellow(
        'Could not reach the npm registry to check for the latest version ' +
          '(offline or npm not in PATH).',
      ),
    );
    console.log(
      chalk.yellow(
        'To update manually, run: npm install -g nodal-agents@latest && nodal-agents up',
      ),
    );
    process.exit(1);
  }

  // ── 2. Already up to date ──────────────────────────────────────────────────

  if (installed === latest) {
    console.log(chalk.green(`  ✓ Already on the latest version (${installed})`));
    return;
  }

  // ── 3. Announce the update ─────────────────────────────────────────────────

  console.log(chalk.cyan(`  ↑ Updating ${installed} → ${latest}`));

  // ── 4. Stop services (best-effort — important on Windows to release handles
  //       before npm rewrites the global package, see plan 4.1 note on EPERM) ─

  console.log(chalk.gray('  Stopping services…'));
  try {
    await runDown();
  } catch {
    // best-effort — keep going even if some process refused to stop
  }

  // ── 5. Install ─────────────────────────────────────────────────────────────

  console.log(chalk.gray('  Installing nodal-agents@latest…'));
  try {
    await execa('npm', ['install', '-g', 'nodal-agents@latest'], { stdio: 'inherit' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);

    if (code === 'ENOENT' || message.includes('ENOENT')) {
      // npm is not on PATH — give a concrete fix.
      console.error(
        chalk.red(
          '\n  ✗ npm not found in PATH.\n' +
            '  Make sure Node.js is installed and `npm` is on your PATH,\n' +
            '  then re-run `nodal-agents update`.',
        ),
      );
      process.exit(1);
    }

    if (
      code === 'EACCES' ||
      message.toLowerCase().includes('permission') ||
      message.includes('EACCES')
    ) {
      // Insufficient permissions — actionable message for the user.
      console.error(
        chalk.red(
          '\n  ✗ Permission denied while installing.\n' +
            '  Run the command with elevated privileges:\n' +
            (process.platform === 'win32'
              ? '    Run your terminal as Administrator, then retry `nodal-agents update`.'
              : '    sudo nodal-agents update'),
        ),
      );
      process.exit(1);
    }

    // Unknown error — re-throw to let the top-level handler print and exit 1.
    throw err;
  }

  console.log(chalk.green('  ✓ nodal-agents updated.'));

  // ── 6. Restart ─────────────────────────────────────────────────────────────

  if (opts.noRestart) {
    console.log(chalk.cyan('  Run `nodal-agents up` to start the updated stack.'));
    return;
  }

  // Spawn the global `nodal-agents up` DETACHED so it outlives this process
  // and resolves the NEW global shim (the fresh cli.js written by npm install).
  // We deliberately do NOT await — the goal is fire-and-forget.
  console.log(chalk.gray('  Starting updated services (detached)…'));
  try {
    const child = execa('nodal-agents', ['up'], {
      detached: true,
      stdio: 'ignore',
      // Prefer the PATH-resolved global shim so the new version is loaded.
      shell: process.platform === 'win32',
    });
    child.unref();
  } catch {
    // Spawn itself failed (e.g. nodal-agents not yet on PATH after install).
    // Give the user a clear fallback rather than crashing silently.
    console.log(
      chalk.yellow(
        '  Could not auto-start. Run `nodal-agents up` manually to start the updated stack.',
      ),
    );
  }

  console.log(chalk.green(`  ✓ Updated to ${latest}. Services starting in background.`));
}
