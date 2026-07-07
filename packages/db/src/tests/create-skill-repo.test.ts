// create-skill-repo.test.ts — tests for createSkillRepo()'s reserved-slug
// refusal (P2b, F-6 follow-up). Asserts on real DB rows — never call counts.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { createSkillRepo } from '../repos/skills.ts';
import * as schema from '../schema/index.ts';

let db: TestDb;
let entityId: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const seed = await seedMinimal(db);
  entityId = seed.entityId;
});

describe('createSkillRepo — reserved slug refusal (P2b, F-6 follow-up)', () => {
  it('refuses a slug that collides with the reserved (system-catalog) list — no row is written', async () => {
    const reservedSlug = `reserved-catalog-slug-${Date.now()}`;

    const result = await createSkillRepo(
      db,
      entityId,
      {
        slug: reservedSlug,
        name: 'Attempted Squat',
        content: '# should never be written',
        description: undefined,
      },
      [reservedSlug],
    );

    expect(result).toEqual({ error: 'slug_reserved' });

    const rows = await db
      .select({ id: schema.agentSkills.id })
      .from(schema.agentSkills)
      .where(
        and(eq(schema.agentSkills.entityId, entityId), eq(schema.agentSkills.slug, reservedSlug)),
      );
    expect(rows).toHaveLength(0);
  });

  it('still allows a non-reserved slug when a reserved list is provided', async () => {
    const okSlug = `not-reserved-${Date.now()}`;
    const result = await createSkillRepo(
      db,
      entityId,
      {
        slug: okSlug,
        name: 'Fine Skill',
        content: '# ok',
        description: undefined,
      },
      [`some-other-reserved-slug-${Date.now()}`],
    );

    expect('id' in result).toBe(true);
  });

  it('back-compat: omitting the reserved list entirely reserves nothing', async () => {
    const slug = `no-reserved-list-${Date.now()}`;
    const result = await createSkillRepo(db, entityId, {
      slug,
      name: 'No Reserved List',
      content: '# ok',
      description: undefined,
    });

    expect('id' in result).toBe(true);
  });
});
