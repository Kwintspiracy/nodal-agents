// seed.ts — seed the default local user + entity (no starter agent)
// Idempotent: safe to call multiple times.
//
// We DON'T seed a default agent. The user creates their first agent
// intentionally from the dashboard — no surprise rows in their DB.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import { seedLocalUser, LOCAL_USER_ID, LOCAL_ENTITY_ID } from '@nodal-agents/auth';

/**
 * Seed the local user + entity (via @nodal-agents/auth seedLocalUser).
 * No agent is created — the user does that from the dashboard.
 *
 * Idempotent: calling twice doesn't create duplicates (seedLocalUser
 * itself is idempotent).
 *
 * The `model` parameter is kept for API compatibility but is no longer used.
 * It can be removed once no caller passes it.
 */
export async function seedDefaultUserEntityAgent(
  db: AnyDrizzleDb,
  _model: string | null = null,
): Promise<{ userId: string; entityId: string }> {
  void _model; // intentionally unused — see comment above
  const { userId, entityId } = await seedLocalUser(db);
  return { userId, entityId };
}

// Re-export constants for consumers
export { LOCAL_USER_ID, LOCAL_ENTITY_ID };
