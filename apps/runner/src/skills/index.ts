// skills/ — community skill installation (open Agent Skills / SKILL.md format).
//
// Public surface for the runner: the install/uninstall/update orchestrators,
// the update-check module, the store-directory resolver, and the typed errors
// each step can throw.

export { skillStoreDir } from './store-dir';
export {
  installCommunitySkill,
  uninstallCommunitySkill,
  previewSkillRemoval,
  applySkillUpdate,
  previewSkillUpdate,
  acknowledgeSkillUpdate,
  SkillInstallError,
} from './install';
export type {
  InstallSkillOptions,
  InstallSkillResult,
  UninstallSkillOptions,
  SkillRemovalPreview,
  ApplySkillUpdateOptions,
  ApplySkillUpdateResult,
  AcknowledgeSkillUpdateOptions,
  AcknowledgeSkillUpdateResult,
  PreviewSkillUpdateResult,
  FileChange,
  ConflictChoice,
} from './install';
export { checkSkillUpdate } from './check-updates';
export type { SkillUpdateCheckSkill, SkillUpdateCheckOutcome } from './check-updates';
export { parseSkillSource, SkillSourceError } from './source';
export { SkillFetchError } from './fetch';
export { FrontmatterError } from './frontmatter';
export type { DetectedScript } from './detect-scripts';
