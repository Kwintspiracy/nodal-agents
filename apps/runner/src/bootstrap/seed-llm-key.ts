// bootstrap/seed-llm-key.ts — Brique 24 / Brique 25
//
// On runner startup, if the single local entity has zero entity_llm_keys rows
// AND LLM_PROVIDER + LLM_MODEL are configured in env, seed a default row from
// env so existing agents (which were created against the env-based singleton)
// continue to work without manual setup.
//
// Idempotent: skipped when the table already has rows for the entity.
//
// Guard logic (Brique 25):
//   - bearer-token mode: skip (multi-tenant, admins manage keys via UI)
//   - exactly 1 entity in DB → seed for that entity (works for both
//     local-trust and single-user local-auth installs like Quentin's)
//   - >1 entities → skip (future multi-user installs, avoid wrong-entity seeding)

import { count, eq, isNull, and, entityLlmKeys, agents, entities } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';
import { encrypt, last4 } from '@nodalai/secrets';
import type { RunnerEnv } from '../env.ts';

export async function seedDefaultLlmKey(db: AnyDrizzleDb, env: RunnerEnv): Promise<void> {
  // bearer-token mode = multi-tenant; admins manage keys via UI, never auto-seed.
  if (env.AUTH_MODE === 'bearer-token') return;
  if (!env.LLM_PROVIDER || !env.LLM_MODEL) return;

  // Resolve target entity: must be exactly 1 in DB.
  // - local-trust: LOCAL_ENTITY_ID is the sole entity → always exactly 1
  // - local-auth single-user: exactly 1 entity after first sign-up → seeds
  // - local-auth multi-user (future): >1 entities → skip to avoid wrong seeding
  const [entityCountRow] = await db.select({ n: count() }).from(entities);
  const entityCount = entityCountRow?.n ?? 0;

  if (entityCount !== 1) return; // 0 entities (first boot before sign-up) or >1

  const [entityRow] = await db.select({ id: entities.id }).from(entities).limit(1);
  if (!entityRow) return;

  const targetEntityId = entityRow.id;

  const [keyCountRow] = await db
    .select({ n: count() })
    .from(entityLlmKeys)
    .where(eq(entityLlmKeys.entityId, targetEntityId));

  if ((keyCountRow?.n ?? 0) > 0) return; // already seeded

  const plaintextKey = env.LLM_API_KEY ?? '';
  const [newKey] = await db
    .insert(entityLlmKeys)
    .values({
      entityId: targetEntityId,
      provider: env.LLM_PROVIDER,
      apiKey: encrypt(plaintextKey),
      apiKeyLast4: last4(plaintextKey),
      baseUrl: env.LLM_BASE_URL ?? null,
      nickname: 'Default (env)',
      defaultModel: env.LLM_MODEL,
      isActive: true,
    })
    .returning({ id: entityLlmKeys.id });

  if (!newKey) return;

  // Wire any existing agents in this entity that don't yet have an llmKeyId
  // — keeps prior-Brique-24 agents working out of the box.
  await db
    .update(agents)
    .set({ llmKeyId: newKey.id, updatedAt: new Date() })
    .where(and(eq(agents.entityId, targetEntityId), isNull(agents.llmKeyId)));

  console.warn(
    `[runner] seeded default LLM key ${newKey.id} from env (entityId=${targetEntityId})`,
  );
}
