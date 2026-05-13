// Convenience helpers for request-level auth enforcement.
// Throws typed errors so callers can discriminate without string matching.

import type { AuthProvider, AuthSession } from './types.ts';
import { AuthError, NoEntityError } from './types.ts';
import { eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

/**
 * Resolves the session from the request, throwing AuthError if unauthenticated.
 */
export async function requireAuth(req: Request, provider: AuthProvider): Promise<AuthSession> {
  const session = await provider.getSession(req);
  if (!session) throw new AuthError();
  return session;
}

/**
 * Resolves the session AND verifies the user has at least one entity_member row.
 * Throws AuthError if unauthenticated, NoEntityError if no entity membership.
 */
export async function requireAuthWithEntity(
  req: Request,
  provider: AuthProvider,
  db: AnyDrizzleDb,
): Promise<AuthSession> {
  const session = await requireAuth(req, provider);

  const { entityMembers } = await import('@nodal-agents/db/schema');

  const rows = await db
    .select({ entityId: entityMembers.entityId })
    .from(entityMembers)
    .where(eq(entityMembers.userId, session.userId));

  if (rows.length === 0) throw new NoEntityError();

  // If the provider already resolved an entityId, trust it.
  // Otherwise fall back to the first membership row.
  const resolvedEntityId =
    session.entityId !== ''
      ? session.entityId
      : ((rows[0]?.['entityId'] as string | undefined) ?? '');

  if (!resolvedEntityId) throw new NoEntityError();

  return { userId: session.userId, entityId: resolvedEntityId };
}
