// bootstrap/seed-default-agents.ts — system agents, shipped with the product.
//
// For each entry in `systemAgents`, ensure an `agents` row exists in the
// local entity with the canonical personality + model preference. Idempotent:
//
//   - Agent doesn't exist (fresh install) → INSERT with canonical personality,
//     systemAgent=true, model = best matching preferred model from available
//     LLM keys, falling back to the first available key's defaultModel.
//   - Agent exists (upgrade case) → UPDATE only structural fields (name, role,
//     orchestratorMode). Personality is treated as USER-OWNED once the row
//     exists — we never overwrite an existing personality. Users can edit
//     freely via dashboard, and a future "Reset to default" UX will let them
//     opt in to a new canonical personality.
//
//   Limitation noted: this means an existing install does NOT receive
//   personality updates when the canonical changes between npm versions.
//   Acceptable for MVP; future schema work can add a `personality_overridden`
//   flag mirroring `agent_skills.content_overridden` for a finer story.
//
// Guard: same single-entity gate as `seedDefaultLlmKey` /
// `seedDefaultSkills`. Multi-tenant deploys do catalog seeding via dedicated
// tooling.

import { count, eq } from '@nodal-agents/db';
import { agents, entityLlmKeys, entities } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { RunnerEnv } from '../env.ts';
import { systemAgents } from './catalog/index.ts';
import type { ModelPreference } from './catalog/types.ts';

/**
 * Resolve which `entity_llm_keys.id` + concrete model id to seed an agent
 * with, based on its `preferredModels` ordering. First preference whose
 * provider matches an available key wins. If none match, returns the first
 * available key + its declared default model (so the agent at least boots).
 */
function resolveModel(
  preferredModels: ModelPreference[],
  availableKeys: Array<{ id: string; provider: string; defaultModel: string | null }>,
): { llmKeyId: string; model: string } | null {
  for (const pref of preferredModels) {
    const match = availableKeys.find((k) => k.provider === pref.provider);
    if (match) {
      return { llmKeyId: match.id, model: pref.model };
    }
  }
  // No preference matched — fall back to first available key.
  const fallback = availableKeys[0];
  if (!fallback) return null;
  return {
    llmKeyId: fallback.id,
    model: fallback.defaultModel ?? preferredModels[0]?.model ?? '',
  };
}

export async function seedDefaultAgents(db: AnyDrizzleDb, env: RunnerEnv): Promise<void> {
  if (env.AUTH_MODE === 'bearer-token') return;

  const [entityCountRow] = await db.select({ n: count() }).from(entities);
  if ((entityCountRow?.n ?? 0) !== 1) return;
  const [entityRow] = await db.select({ id: entities.id }).from(entities).limit(1);
  if (!entityRow) return;
  const targetEntityId = entityRow.id;

  // Available LLM keys for this entity. May be empty (fresh install before
  // sign-up populates the env key); in that case we still seed the agent
  // rows but leave llmKeyId NULL — they get wired up when seedDefaultLlmKey
  // runs (which is called BEFORE this seeder).
  const availableKeys = await db
    .select({
      id: entityLlmKeys.id,
      provider: entityLlmKeys.provider,
      defaultModel: entityLlmKeys.defaultModel,
    })
    .from(entityLlmKeys)
    .where(eq(entityLlmKeys.entityId, targetEntityId));

  let created = 0;
  let updatedStructural = 0;

  for (const agent of systemAgents) {
    const [existing] = await db
      .select({
        id: agents.id,
        systemAgent: agents.systemAgent,
      })
      .from(agents)
      .where(eq(agents.slug, agent.slug))
      .limit(1);

    if (!existing) {
      const resolved = resolveModel(agent.preferredModels, availableKeys);
      await db.insert(agents).values({
        entityId: targetEntityId,
        slug: agent.slug,
        name: agent.name,
        role: agent.role,
        orchestratorMode: agent.orchestratorMode ?? null,
        personality: agent.personality,
        model: resolved?.model ?? agent.preferredModels[0]?.model ?? 'claude-sonnet-4-6',
        llmKeyId: resolved?.llmKeyId ?? null,
        systemAgent: true,
        active: true,
      });
      created++;
      continue;
    }

    // Existing row: update structural fields only (never touch personality
    // — see header comment). Also ensure systemAgent flag is set so future
    // logic can distinguish system rows from user rows.
    await db
      .update(agents)
      .set({
        name: agent.name,
        role: agent.role,
        orchestratorMode: agent.orchestratorMode ?? null,
        systemAgent: true,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, existing.id));
    updatedStructural++;
  }

  if (created || updatedStructural) {
    console.warn(
      `[runner] system agents seeded — created=${created}, structural-updated=${updatedStructural} (entityId=${targetEntityId})`,
    );
  }
}
