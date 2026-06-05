// skills/ — community skill installation (open Agent Skills / SKILL.md format).
//
// Public surface for the runner: the install/uninstall orchestrators, the
// store-directory resolver, and the typed errors each step can throw.

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Absolute path to the community-skill store. Mirrors the secrets/config
 * convention (`~/.nodalai/...`). Each installed skill's files live under
 * `<skillStoreDir>/<slug>/`. Injected into the tool ToolContext at job start
 * and used by the installer routes.
 */
export function skillStoreDir(): string {
  return join(homedir(), '.nodalai', 'skills');
}

export {
  installCommunitySkill,
  uninstallCommunitySkill,
  SkillInstallError,
} from './install';
export type {
  InstallSkillOptions,
  InstallSkillResult,
  UninstallSkillOptions,
} from './install';
export { parseSkillSource, SkillSourceError } from './source';
export { SkillFetchError } from './fetch';
export { FrontmatterError } from './frontmatter';
export type { DetectedScript } from './detect-scripts';
