// root.ts — where the shadow checkpoint store lives.
//
// ONE function, used by both sides. That is the entire point of the file.
//
// The first version had two: `apps/runner` derived the path from
// `workspacesRoot()`, `apps/cli` from `CONFIG_DIR`. They agreed by default and
// diverged the moment `NODALAI_WORKSPACES_ROOT` was set — the runner would then
// write snapshots beside that override while `nodal-agents checkpoints list`
// kept reading `~/.nodalai/checkpoints`, reporting "no checkpoints" forever
// while they piled up unseen. That is the worst shape a safety net can take:
// it does not look broken, it looks like nothing ever happened.
//
// Found by writing the test that pinned the two together, not by re-reading.

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Absolute path to the shared shadow checkpoint store:
 *
 *   ~/.nodalai/checkpoints/
 *     ├── store/         (one bare git object database, shared)
 *     ├── indexes/<key>  (one staging index per workspace)
 *     └── gitconfig      (empty — pins the owner's git config out of the way)
 *
 * Machine-scoped, not per entity: the store is content-addressed, so one shared
 * database means a hundred snapshots of a tree cost roughly one copy plus the
 * deltas. Snapshots are addressed by workspace-path hash — nothing in there is
 * reachable without knowing which path to ask for.
 */
export function checkpointsRoot(): string {
  return process.env['NODALAI_CHECKPOINTS_ROOT'] ?? join(homedir(), '.nodalai', 'checkpoints');
}
