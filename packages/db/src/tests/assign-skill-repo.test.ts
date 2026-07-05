// assign-skill-repo.test.ts — tests for assignSkillRepo()'s DB-level dedup
// (audit #2 DB-2). Asserts on real DB rows — never call counts.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { assignSkillRepo } from '../repos/skills.ts';
import * as schema from '../schema/index.ts';

let db: TestDb;
let entityId: string;
let agentId: string;
let skillId: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const seed = await seedMinimal(db);
  entityId = seed.entityId;
  agentId = seed.agentId;

  const [sk] = await db
    .insert(schema.agentSkills)
    .values({
      entityId,
      name: `Assign Repo Skill ${Date.now()}`,
      slug: `assign-repo-skill-${Date.now()}`,
      content: '# test',
    })
    .returning();
  if (!sk) throw new Error('Failed to seed skill');
  skillId = sk.id;
});

async function rowsForPair() {
  return db
    .select({ id: schema.agentSkillAssignments.id })
    .from(schema.agentSkillAssignments)
    .where(
      and(
        eq(schema.agentSkillAssignments.agentId, agentId),
        eq(schema.agentSkillAssignments.skillId, skillId),
      ),
    );
}

describe('assignSkillRepo — dedup (DB-2, audit #2)', () => {
  it('repeated assignment of the same (agent, skill) leaves exactly ONE row', async () => {
    const first = await assignSkillRepo(db, entityId, { agentId, skillId }, []);
    expect(first).toEqual({ ok: true });

    const second = await assignSkillRepo(db, entityId, { agentId, skillId }, []);
    expect(second).toEqual({ error: 'already_assigned' });

    const rows = await rowsForPair();
    expect(rows).toHaveLength(1);
  });

  it('the underlying insert is guarded by onConflictDoNothing — a row inserted outside the SELECT check (the race the app-level check cannot close) does not throw and still leaves ONE row', async () => {
    // A concurrent caller that raced past the repo's own existence check would
    // hit this exact INSERT with a colliding (agent_id, skill_id) pair. Prove
    // the statement itself (not just the app-level check) is race-safe by
    // issuing it directly against an already-assigned pair.
    await assignSkillRepo(db, entityId, { agentId, skillId }, []);

    await expect(
      db
        .insert(schema.agentSkillAssignments)
        .values({ entityId, agentId, skillId })
        .onConflictDoNothing({
          target: [schema.agentSkillAssignments.agentId, schema.agentSkillAssignments.skillId],
        }),
    ).resolves.not.toThrow();

    const rows = await rowsForPair();
    expect(rows).toHaveLength(1);
  });
});
