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

// ─── Repos ─────────────────────────────────────────────────────────────────────
export { createAgentRepo } from './repos/agents.ts';
export type { CreateAgentInput, CreateAgentResult } from './repos/agents.ts';
export { createSkillRepo, assignSkillRepo } from './repos/skills.ts';
export type {
  CreateSkillInput,
  CreateSkillResult,
  AssignSkillInput,
  AssignSkillResult,
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
