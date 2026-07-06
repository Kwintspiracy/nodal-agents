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
// Source of truth = `packages/catalog/src/skills/*.ts`. Adding a new system
// skill means a new TS file + an entry in `packages/catalog/src/index.ts`,
// then a runner restart on every install picks it up.
//
// Guard: skip in bearer-token mode (multi-tenant SaaS — admins manage the
// catalog explicitly) and when the DB has no entity yet (fresh pre-signup
// boot — the cron ticker re-attempts later). Otherwise seed: `agent_skills`
// rows are matched by slug scoped to the bookkeeping owner entity (see F-6,
// audit #2 — slug is unique per (entity_id, slug), not globally, since
// 2026-07), so there is one install-wide set of system skills. The oldest
// entity is the bookkeeping owner for any rows inserted fresh; existing rows
// refresh in place under that same entity.
//
// SECURITY (F-6 follow-up, P2b): system skills are made assignable to OTHER
// entities via assignSkillRepo's `systemSkillSlugs` check. Relaxing the
// global slug unique constraint (F-6) opened a squat vector — another entity
// could create its OWN skill whose slug collides with a catalog slug, and a
// THIRD entity could then attach_skill that impostor row believing it's the
// real system skill. Closed by stamping `createdBy: 'system'` on every row
// this seeder writes (below) and requiring BOTH slug membership AND
// createdBy='system' at every cross-entity system-skill check
// (listSkillsAction, getSkillByIdAction, assignSkillRepo) — createdBy is not
// forgeable by any user-facing path (create_skill / createSkillRepo always
// default it to 'user' unless explicitly overridden by the reflection/
// curator passes, which pass 'agent', never 'system'). createSkillRepo also
// refuses a user/agent-supplied slug that collides with the catalog outright
// (reservedSlugs param), closing the vector at the source too.
//
// Existing installs self-heal: this seeder runs on every boot and the UPDATE
// branches below now also stamp createdBy='system', so a pre-F-6 row missing
// the flag gets it on the next restart.

import { eq, and } from '@nodal-agents/db';
import { agentSkills, entities } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { RunnerEnv } from '../env.ts';
import { systemSkills } from '@nodal-agents/catalog';

export async function seedDefaultSkills(db: AnyDrizzleDb, env: RunnerEnv): Promise<void> {
  // bearer-token mode = multi-tenant; admins manage catalog explicitly.
  if (env.AUTH_MODE === 'bearer-token') return;

  // Bookkeeping owner for freshly-inserted skill rows = the oldest entity.
  // Skip only when there is no entity at all (fresh DB before first signup).
  const [entityRow] = await db
    .select({ id: entities.id })
    .from(entities)
    .orderBy(entities.createdAt)
    .limit(1);
  if (!entityRow) return;
  const targetEntityId = entityRow.id;

  let created = 0;
  let updatedDefaults = 0;
  let updatedFull = 0;

  for (const skill of systemSkills) {
    // F-6 (audit #2): slug is unique per (entity_id, slug), not globally —
    // an unscoped lookup could find a DIFFERENT entity's user-authored skill
    // that happens to share this catalog slug and overwrite its content,
    // mistaking it for the system skill. Scope to the bookkeeping owner
    // (targetEntityId): the real system-skill row, if it exists, always
    // lives there (this seeder only ever inserts under targetEntityId), so
    // scoping cannot miss it — it can only avoid touching a foreign row.
    const [existing] = await db
      .select({
        id: agentSkills.id,
        contentOverridden: agentSkills.contentOverridden,
      })
      .from(agentSkills)
      .where(and(eq(agentSkills.slug, skill.slug), eq(agentSkills.entityId, targetEntityId)))
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
        // P2b (F-6 follow-up): stamps this row as the ground-truth system
        // skill — every cross-entity system-skill check requires this flag,
        // not just slug string membership (see security note above).
        createdBy: 'system',
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
          createdBy: 'system',
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
          createdBy: 'system',
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
