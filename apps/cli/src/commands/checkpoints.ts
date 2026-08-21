// checkpoints.ts — list and restore the snapshots taken before an agent wrote.
//
// The snapshots themselves are invisible: no tool exposes them, and the model
// cannot call them. This command is the other half — a net nobody can reach is
// not a net, it is storage.
//
// Restoring is deliberately a human gesture. Deciding that a run went wrong is
// a judgement, and an agent able to roll itself back could also roll back the
// evidence of what it did.

import chalk from 'chalk';
import { resolve } from 'node:path';
import { listCheckpoints, restoreCheckpoint, checkpointsRoot } from '@nodal-agents/checkpoints';
import type { Checkpoint } from '@nodal-agents/checkpoints';

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export async function runCheckpointsList(workspace?: string): Promise<void> {
  const ws = resolve(workspace ?? process.cwd());
  const list = await listCheckpoints(checkpointsRoot(), ws);

  if (list.length === 0) {
    console.log(chalk.yellow(`No checkpoints for ${ws}`));
    console.log(
      chalk.gray(
        '  Snapshots are taken before an agent writes. None here means no agent has\n' +
          '  written to this path — or that it is not the workspace root the runner uses.',
      ),
    );
    return;
  }

  console.log(chalk.bold(`\nCheckpoints for ${ws}\n`));
  for (const cp of list) {
    console.log(
      `  ${chalk.cyan(cp.sha.slice(0, 8))}  ${chalk.gray(ago(cp.at).padEnd(12))}  ${cp.label}`,
    );
  }
  console.log(chalk.gray(`\n  Restore one:  nodal-agents checkpoints restore <sha>\n`));
}

export async function runCheckpointsRestore(sha: string, workspace?: string): Promise<void> {
  const ws = resolve(workspace ?? process.cwd());
  const list = await listCheckpoints(checkpointsRoot(), ws, 200);

  const match = list.find((c: Checkpoint) => c.sha.startsWith(sha));
  if (!match) {
    // Fail loud with what IS available, rather than a bare "not found" that
    // leaves the user guessing whether they mistyped or looked in the wrong
    // workspace.
    throw new Error(
      `checkpoint_not_found: no checkpoint starting with "${sha}" for ${ws}.\n` +
        (list.length > 0
          ? `  Available: ${list
              .slice(0, 5)
              .map((c: Checkpoint) => c.sha.slice(0, 8))
              .join(', ')}`
          : '  This workspace has no checkpoints at all.'),
    );
  }

  console.log(chalk.yellow(`Restoring ${match.sha.slice(0, 8)} — ${match.label}`));
  const res = await restoreCheckpoint(checkpointsRoot(), ws, match.sha);
  console.log(chalk.green(`  Restored ${ws}`));

  if (res.safety) {
    // The state being discarded may have been the one worth keeping, so it is
    // captured first and the way back is printed immediately — not buried in a
    // list the user would have to think to consult.
    console.log(
      chalk.gray(
        `  The state you just replaced was saved as ${res.safety.sha.slice(0, 8)}.\n` +
          `  Undo this restore:  nodal-agents checkpoints restore ${res.safety.sha.slice(0, 8)}`,
      ),
    );
  }
}
