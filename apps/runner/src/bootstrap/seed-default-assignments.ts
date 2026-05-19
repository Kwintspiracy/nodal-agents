// bootstrap/seed-default-assignments.ts — link system skills to system agents.
//
// For each entry in `systemAssignments`, ensure an `agent_skill_assignments`
// row exists linking the agent (by slug) to the skill (by slug). Idempotent:
//
//   - Assignment doesn't exist → INSERT.
//   - Assignment exists → no-op (idempotent).
//
// One subtle UX choice: if a user DELETES a default assignment via the
// dashboard, this seeder will recreate it on the next boot. That's a known
// limitation — to track "user removed this default" we'd need a separate
// table or column flag. Out of scope for MVP. Workaround for users who
// dislike a default: keep the assignment but ignore it (the agent ignores
// skills it doesn't need).
//
// Guard: single-entity gate, same as the other seeders.

import { and, count, eq } from '@nodal-agents/db';
import { agents, agentSkills, agentSkillAssignments, entities } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { RunnerEnv } from '../env.ts';
import { systemAssignments } from './catalog/index.ts';

export async function seedDefaultAssignments(db: AnyDrizzleDb, env: RunnerEnv): Promise<void> {
  if (env.AUTH_MODE === 'bearer-token') return;

  const [entityCountRow] = await db.select({ n: count() }).from(entities);
  if ((entityCountRow?.n ?? 0) !== 1) return;
  const [entityRow] = await db.select({ id: entities.id }).from(entities).limit(1);
  if (!entityRow) return;
  const targetEntityId = entityRow.id;

  let created = 0;

  for (const link of systemAssignments) {
    const [agentRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, link.agentSlug))
      .limit(1);
    const [skillRow] = await db
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(eq(agentSkills.slug, link.skillSlug))
      .limit(1);

    if (!agentRow || !skillRow) continue; // agent or skill missing — silent (the
    // other seeders would have created them; if they didn't, the catalog has
    // an inconsistency that should fail loud elsewhere).

    const [existing] = await db
      .select({ id: agentSkillAssignments.id })
      .from(agentSkillAssignments)
      .where(
        and(
          eq(agentSkillAssignments.agentId, agentRow.id),
          eq(agentSkillAssignments.skillId, skillRow.id),
        ),
      )
      .limit(1);

    if (!existing) {
      await db.insert(agentSkillAssignments).values({
        entityId: targetEntityId,
        agentId: agentRow.id,
        skillId: skillRow.id,
      });
      created++;
    }
  }

  if (created) {
    console.warn(
      `[runner] system skill assignments seeded — created=${created} (entityId=${targetEntityId})`,
    );
  }
}
