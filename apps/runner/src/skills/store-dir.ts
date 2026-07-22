// skills/store-dir.ts — resolves the on-disk root for an entity's installed
// community skills. Split out from index.ts (the barrel) so check-updates.ts
// can depend on it without importing the barrel — index.ts re-exports from
// both install.ts and check-updates.ts, so a check-updates.ts → index.ts
// import would create a cycle.

import { join } from 'node:path';

import { workspacesRoot } from '../lib/workspaces-root.ts';

/**
 * Absolute path to the community-skill store for an entity. Lives UNDER that
 * entity's workspace tree so everything an entity owns is one coherent root:
 *
 *   ~/.nodalai/workspaces/<entityId>/
 *     ├── shared/            (the agents' shared file area)
 *     └── skills/<slug>/     (installed community skills + their scripts)
 *
 * Entity-scoped so two entities (e.g. two LAN users) installing the same slug
 * never collide on disk — matching the per-entity workspace + DB skill rows.
 * `entityId` is null only for system jobs, which never have community skills;
 * they get a stable `_system` bucket. Injected into the tool ToolContext at job
 * start and used by the installer routes.
 */
export function skillStoreDir(entityId: string | null): string {
  return join(workspacesRoot(), entityId ?? '_system', 'skills');
}
