// lib/workspaces-root.ts — single resolver for the on-disk workspaces root.
//
// Every path under ~/.nodalai/workspaces/ (shared workspace, inbound channel
// media, community-skill store) MUST go through this helper. The env override
// exists for tests: vitest points NODALAI_WORKSPACES_ROOT at a temp dir so
// suites that drive executeJob with synthetic entities never write into the
// real home directory (5k+ empty <uuid>/shared dirs had accumulated there
// before this guard — one per test-run entity).

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root directory holding one subtree per entity (`<root>/<entityId>/…`). */
export function workspacesRoot(): string {
  return process.env['NODALAI_WORKSPACES_ROOT'] ?? join(homedir(), '.nodalai', 'workspaces');
}
