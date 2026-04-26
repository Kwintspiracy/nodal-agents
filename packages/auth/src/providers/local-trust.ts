// local-trust provider — loopback trust.
// Zero auth check: any request that reaches the server is treated as the
// single local user. Default mode for a local install.

import { eq, and } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';
import type { AuthProvider, AuthSession } from '../types.ts';

// Re-exported constants so callers can reference the fixed local UUIDs.
export const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001';
export const LOCAL_ENTITY_ID = '00000000-0000-0000-0000-000000000002';

const LOCAL_SESSION: AuthSession = {
  userId: LOCAL_USER_ID,
  entityId: LOCAL_ENTITY_ID,
};

// ─── Provider ─────────────────────────────────────────────────────────────────

export class LocalTrustProvider implements AuthProvider {
  getSession(_req: Request): Promise<AuthSession | null> {
    return Promise.resolve(LOCAL_SESSION);
  }
}

// ─── Seed helper ──────────────────────────────────────────────────────────────

/**
 * Idempotent: inserts the local user + entity + entity_member if not present.
 * Accepts any Drizzle db instance built over the @nodalai/db schema
 * (both postgres-js and pglite instances work).
 */
export async function seedLocalUser(
  db: AnyDrizzleDb,
): Promise<{ userId: string; entityId: string }> {
  const { users, entities, entityMembers } = await import('@nodalai/db/schema');

  // User — keyed by fixed UUID so ON CONFLICT DO NOTHING is safe
  await db
    .insert(users)
    .values({
      id: LOCAL_USER_ID,
      email: 'local@nodalai.local',
    })
    .onConflictDoNothing();

  // Entity
  await db
    .insert(entities)
    .values({
      id: LOCAL_ENTITY_ID,
      userId: LOCAL_USER_ID,
      name: 'Local',
      slug: 'local',
    })
    .onConflictDoNothing();

  // Entity member — guarded by a SELECT to avoid duplicate inserts on DBs
  // that don't support partial ON CONFLICT targeting
  const existing = await db
    .select({ id: entityMembers.id })
    .from(entityMembers)
    .where(
      and(eq(entityMembers.userId, LOCAL_USER_ID), eq(entityMembers.entityId, LOCAL_ENTITY_ID)),
    );

  if (existing.length === 0) {
    await db.insert(entityMembers).values({
      userId: LOCAL_USER_ID,
      entityId: LOCAL_ENTITY_ID,
      role: 'owner',
    });
  }

  return { userId: LOCAL_USER_ID, entityId: LOCAL_ENTITY_ID };
}
