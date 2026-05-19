// bootstrap/seed-default-skills.ts — system skills, shipped with the product.
//
// For each entry in `systemSkills`, ensure an `agent_skills` row exists in
// the local entity with the canonical content. Idempotent and override-aware:
//
//   - Skill doesn't exist (fresh install) → INSERT with content = default_content
//     = canonical, content_overridden = false.
//   - Skill exists AND content_overridden = false → UPDATE both `content` and
//     `default_content` to the new canonical. User had no edits, so they get
//     the latest version automatically on upgrade.
//   - Skill exists AND content_overridden = true → UPDATE ONLY `default_content`
//     to the new canonical, leave `content` untouched. The dashboard's "Reset
//     to default" button later can copy default_content → content + flip the
//     flag.
//
// Source of truth = `packages/runner/src/bootstrap/catalog/skills/*.ts`. Adding
// a new system skill means a new TS file + an entry in `catalog/index.ts`,
// then a runner restart on every install picks it up.
//
// Guard logic mirrors `seedDefaultLlmKey`: skip unless the install has
// exactly one entity (single-tenant single-user case — local-trust or
// post-signup local-auth). Multi-tenant deployments handle catalog seeding
// via dedicated tooling (not in this MVP).

import { count, eq } from '@nodal-agents/db';
import { agentSkills, entities } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { RunnerEnv } from '../env.ts';
import { systemSkills } from './catalog/index.ts';

export async function seedDefaultSkills(db: AnyDrizzleDb, env: RunnerEnv): Promise<void> {
  // bearer-token mode = multi-tenant; admins manage catalog explicitly.
  if (env.AUTH_MODE === 'bearer-token') return;

  // Target entity must be exactly 1 in DB (same guard as seedDefaultLlmKey).
  const [entityCountRow] = await db.select({ n: count() }).from(entities);
  if ((entityCountRow?.n ?? 0) !== 1) return;
  const [entityRow] = await db.select({ id: entities.id }).from(entities).limit(1);
  if (!entityRow) return;
  const targetEntityId = entityRow.id;

  let created = 0;
  let updatedDefaults = 0;
  let updatedFull = 0;

  for (const skill of systemSkills) {
    const [existing] = await db
      .select({
        id: agentSkills.id,
        contentOverridden: agentSkills.contentOverridden,
      })
      .from(agentSkills)
      .where(eq(agentSkills.slug, skill.slug))
      .limit(1);

    if (!existing) {
      await db.insert(agentSkills).values({
        entityId: targetEntityId,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        defaultContent: skill.content,
        contentOverridden: false,
        requiredBuiltins: skill.requiredBuiltins ?? [],
        active: true,
      });
      created++;
      continue;
    }

    if (existing.contentOverridden) {
      // User edited this skill — preserve their content. Just refresh the
      // default so "Reset to default" works against the latest canonical.
      await db
        .update(agentSkills)
        .set({
          defaultContent: skill.content,
          // Also refresh description + requiredBuiltins — those are structural
          // not edit-prone, safe to update even when content is overridden.
          description: skill.description,
          requiredBuiltins: skill.requiredBuiltins ?? [],
          updatedAt: new Date(),
        })
        .where(eq(agentSkills.id, existing.id));
      updatedDefaults++;
    } else {
      // No user override → push the new canonical fully.
      await db
        .update(agentSkills)
        .set({
          content: skill.content,
          defaultContent: skill.content,
          description: skill.description,
          requiredBuiltins: skill.requiredBuiltins ?? [],
          updatedAt: new Date(),
        })
        .where(eq(agentSkills.id, existing.id));
      updatedFull++;
    }
  }

  if (created || updatedFull || updatedDefaults) {
    console.warn(
      `[runner] system skills seeded — created=${created}, updated=${updatedFull}, default-only=${updatedDefaults} (entityId=${targetEntityId})`,
    );
  }
}
