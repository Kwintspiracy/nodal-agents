// seed.ts — seed the default local user, entity, and starter agent
// Idempotent: safe to call multiple times

import type { AnyDrizzleDb } from '@nodalai/db';
import { seedLocalUser, LOCAL_USER_ID, LOCAL_ENTITY_ID } from '@nodalai/auth';
import { agents } from '@nodalai/db/schema';
import { eq } from '@nodalai/db';

export const STARTER_AGENT_SLUG = 'starter';

/**
 * Seed the local user + entity (via @nodalai/auth seedLocalUser),
 * then insert a starter agent if one doesn't exist yet.
 *
 * Idempotent: calling twice doesn't create duplicates.
 */
export async function seedDefaultUserEntityAgent(
  db: AnyDrizzleDb,
  model: string | null = null,
): Promise<{ userId: string; entityId: string; agentId: string }> {
  // 1. Seed local user + entity (from @nodalai/auth — already idempotent)
  const { userId, entityId } = await seedLocalUser(db);

  // 2. Seed starter agent
  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.slug, STARTER_AGENT_SLUG));

  let agentId: string;

  if (existing.length > 0 && existing[0]) {
    agentId = existing[0].id;
  } else {
    const inserted = await db
      .insert(agents)
      .values({
        entityId: LOCAL_ENTITY_ID,
        name: 'Starter Agent',
        slug: STARTER_AGENT_SLUG,
        personality:
          'You are a helpful assistant. When you have a response, use the return_result tool to deliver it.',
        model: model,
        active: true,
        isDefault: true,
        role: 'agent',
        maxTokensPerJob: 0,
      })
      .returning({ id: agents.id });

    if (!inserted[0]) {
      throw new Error('Failed to insert starter agent');
    }
    agentId = inserted[0].id;
  }

  return { userId, entityId, agentId };
}

// Re-export constants for consumers
export { LOCAL_USER_ID, LOCAL_ENTITY_ID };
