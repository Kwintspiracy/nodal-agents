// @nodal-agents/db — public API

export { createClient } from './client.ts';
export type { DbClient, CreateClientOptions, AnyDrizzleDb } from './client.ts';

export { withTransaction } from './transaction.ts';

export * from './schema/index.ts';

// ─── Query helpers ─────────────────────────────────────────────────────────────
export {
  getDecryptedCredentialById,
  decryptCredentialForDisplay,
  refreshAndPersistCredential,
} from './queries/credentials.ts';
export type { DecryptedCredential, OauthPayload, Db } from './queries/credentials.ts';
export { assertMasterKeyRestorable } from './queries/master-key-guard.ts';
export type { AssertMasterKeyRestorableOptions } from './queries/master-key-guard.ts';

// ─── Repos ─────────────────────────────────────────────────────────────────────
export { createAgentRepo, attachAgentToOrchestrator } from './repos/agents.ts';
export type { CreateAgentInput, CreateAgentResult, AttachAgentResult } from './repos/agents.ts';
export {
  createSkillRepo,
  updateSkillRepo,
  assignSkillRepo,
  setSkillScriptsAuthorized,
  setSkillFilesWritable,
  touchSkillsLastUsed,
  transitionSkillLifecycle,
  archiveAgentSkill,
} from './repos/skills.ts';
export { pruneOldJobs } from './repos/retention.ts';
export type { PruneResult } from './repos/retention.ts';
export {
  getAppSetting,
  setAppSetting,
  getEntitySetting,
  setEntitySetting,
  getInstallNotes,
  setInstallNotes,
  INSTALL_NOTES_KEY,
} from './repos/app-settings.ts';
export type {
  CreateSkillInput,
  CreateSkillResult,
  UpdateSkillPatch,
  UpdateSkillResult,
  AssignSkillInput,
  AssignSkillResult,
  SetScriptsAuthorizedResult,
  LifecycleThresholds,
  LifecycleResult,
  ArchiveAgentSkillResult,
} from './repos/skills.ts';

// Re-export commonly used Drizzle query helpers so that other packages
// (e.g. packages/auth, packages/memory) can use them without importing
// drizzle-orm directly. Only packages/db may import drizzle-orm (architecture rule).
export {
  eq,
  and,
  or,
  sql,
  desc,
  asc,
  not,
  ne,
  gte,
  lte,
  gt,
  lt,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  ilike,
  like,
  count,
  avg,
  sum,
  max,
  min,
} from 'drizzle-orm';
