// skills/ — community skill installation (open Agent Skills / SKILL.md format).
//
// Public surface for the runner: the install/uninstall orchestrators, the
// store-directory resolver, and the typed errors each step can throw.

import { homedir } from 'node:os';
import { join } from 'node:path';

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
  return join(homedir(), '.nodalai', 'workspaces', entityId ?? '_system', 'skills');
}

export { installCommunitySkill, uninstallCommunitySkill, SkillInstallError } from './install';
export type { InstallSkillOptions, InstallSkillResult, UninstallSkillOptions } from './install';
export { parseSkillSource, SkillSourceError } from './source';
export { SkillFetchError } from './fetch';
export { FrontmatterError } from './frontmatter';
export type { DetectedScript } from './detect-scripts';
