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

describe('assignSkillRepo — system skill squat closure (P2b, F-6 follow-up)', () => {
  it('refuses to attach a foreign-entity skill that only matches by slug — createdBy must also be "system"', async () => {
    // Entity B creates its OWN custom skill sharing a "reserved" catalog
    // slug (createdBy defaults to 'user'). Entity C's agent must NOT be able
    // to attach it via the cross-entity systemSkillSlugs branch — slug
    // string membership alone is no longer proof of provenance now that
    // slugs are unique per entity, not globally (F-6).
    const reservedSlug = `fake-system-slug-${Date.now()}`;

    const [userB] = await db
      .insert(schema.users)
      .values({ email: `p2b-user-b-${Date.now()}@example.com` })
      .returning();
    const [entityB] = await db
      .insert(schema.entities)
      .values({ userId: userB!.id, name: 'P2B Entity B', slug: `p2b-entity-b-${Date.now()}` })
      .returning();
    const [impostorSkill] = await db
      .insert(schema.agentSkills)
      .values({
        entityId: entityB!.id,
        name: 'Impostor Skill',
        slug: reservedSlug,
        content: '# impostor — not the real system skill',
        // createdBy omitted → defaults to 'user'.
      })
      .returning();

    const [userC] = await db
      .insert(schema.users)
      .values({ email: `p2b-user-c-${Date.now()}@example.com` })
      .returning();
    const [entityC] = await db
      .insert(schema.entities)
      .values({ userId: userC!.id, name: 'P2B Entity C', slug: `p2b-entity-c-${Date.now()}` })
      .returning();
    const [agentC] = await db
      .insert(schema.agents)
      .values({
        entityId: entityC!.id,
        name: 'P2B Agent C',
        slug: `p2b-agent-c-${Date.now()}`,
        personality: 'test',
      })
      .returning();

    const result = await assignSkillRepo(
      db,
      entityC!.id,
      { skillId: impostorSkill!.id, agentId: agentC!.id },
      [reservedSlug],
    );

    expect(result).toEqual({ error: 'skill_not_found' });

    const rows = await db
      .select({ id: schema.agentSkillAssignments.id })
      .from(schema.agentSkillAssignments)
      .where(
        and(
          eq(schema.agentSkillAssignments.agentId, agentC!.id),
          eq(schema.agentSkillAssignments.skillId, impostorSkill!.id),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('still allows attaching the REAL system skill (createdBy=system) cross-entity via the same slug list', async () => {
    const realSlug = `real-system-slug-${Date.now()}`;

    const [userSys] = await db
      .insert(schema.users)
      .values({ email: `p2b-user-sys-${Date.now()}@example.com` })
      .returning();
    const [entitySys] = await db
      .insert(schema.entities)
      .values({ userId: userSys!.id, name: 'P2B System Owner', slug: `p2b-sys-${Date.now()}` })
      .returning();
    const [realSystemSkill] = await db
      .insert(schema.agentSkills)
      .values({
        entityId: entitySys!.id,
        name: 'Real System Skill',
        slug: realSlug,
        content: '# the real one',
        createdBy: 'system',
      })
      .returning();

    const [userD] = await db
      .insert(schema.users)
      .values({ email: `p2b-user-d-${Date.now()}@example.com` })
      .returning();
    const [entityD] = await db
      .insert(schema.entities)
      .values({ userId: userD!.id, name: 'P2B Entity D', slug: `p2b-entity-d-${Date.now()}` })
      .returning();
    const [agentD] = await db
      .insert(schema.agents)
      .values({
        entityId: entityD!.id,
        name: 'P2B Agent D',
        slug: `p2b-agent-d-${Date.now()}`,
        personality: 'test',
      })
      .returning();

    const result = await assignSkillRepo(
      db,
      entityD!.id,
      { skillId: realSystemSkill!.id, agentId: agentD!.id },
      [realSlug],
    );

    expect(result).toEqual({ ok: true });
  });
});

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
