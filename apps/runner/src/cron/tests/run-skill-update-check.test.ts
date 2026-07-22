// cron/tests/run-skill-update-check.test.ts — throttle + batch-size + rate-limit
// abort behavior of the update-check cron phase. Real pglite DB (spinUpTestDb/
// seedMinimal) + mocked network (single clawhub zip fetch per skill, same
// pattern as skills/update-flow.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { eq, agentSkills } from '@nodal-agents/db';
import { installCommunitySkill } from '../../skills/install.ts';
import { runSkillUpdateCheckTick } from '../run-skill-update-check.ts';

function makeZip(entries: Array<[string, string]>): Buffer {
  const files: Record<string, Uint8Array> = {};
  for (const [name, content] of entries) files[name] = strToU8(content);
  return Buffer.from(zipSync(files));
}

/** Mocks fetch for exactly the given slugs, each returning `body` unchanged
 * (an "up to date" check). Throws on any other request — proves a throttled
 * skill's fetch is never called. */
function mockUpToDateFetches(slugs: string[], body = 'Hello'): void {
  global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    for (const slug of slugs) {
      if (url === `https://clawhub.ai/api/v1/download?slug=${slug}`) {
        const buf = makeZip([['SKILL.md', `---\nname: ${slug}\ndescription: d\n---\n${body}`]]);
        return new Response(new Uint8Array(buf), { status: 200 });
      }
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

describe('runSkillUpdateCheckTick', () => {
  const origFetch = global.fetch;
  let store: string;

  beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), 'nodal-update-check-tick-'));
  });

  afterEach(async () => {
    global.fetch = origFetch;
    await rm(store, { recursive: true, force: true });
  });

  async function installSkill(
    db: Awaited<ReturnType<typeof spinUpTestDb>>['db'],
    entityId: string,
    slug: string,
  ) {
    mockUpToDateFetches([slug]);
    await installCommunitySkill({
      db: db as never,
      source: `https://clawhub.ai/pub/${slug}`,
      skillStoreDir: store,
      entityId,
    });
  }

  it('does NOT re-check a skill checked within the interval (fetch never called)', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const slug = `throttle-recent-${Date.now()}`;
    await installSkill(db, seed.entityId, slug);
    await db
      .update(agentSkills)
      .set({ lastUpdateCheckAt: new Date() })
      .where(eq(agentSkills.slug, slug));

    // Any fetch call here is a bug — the skill is NOT due.
    global.fetch = vi.fn(async () => {
      throw new Error('fetch should not have been called for a recently-checked skill');
    }) as typeof fetch;

    const result = await runSkillUpdateCheckTick(db as never, {
      SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
      SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
    });

    expect(result.checked).toBe(0);
    expect(result.rateLimited).toBe(false);
  });

  it('checks a skill whose last check is older than the interval', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const slug = `throttle-stale-${Date.now()}`;
    await installSkill(db, seed.entityId, slug);
    const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db
      .update(agentSkills)
      .set({ lastUpdateCheckAt: staleAt })
      .where(eq(agentSkills.slug, slug));

    mockUpToDateFetches([slug]);
    const before = Date.now();
    const result = await runSkillUpdateCheckTick(db as never, {
      SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
      SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
    });

    expect(result.checked).toBe(1);
    expect(result.updatesFound).toBe(0);

    const [after] = await db.select().from(agentSkills).where(eq(agentSkills.slug, slug));
    expect(after!.lastUpdateCheckAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('checks a skill that was never checked before (last_update_check_at IS NULL)', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const slug = `throttle-never-${Date.now()}`;
    await installSkill(db, seed.entityId, slug);

    const [row] = await db.select().from(agentSkills).where(eq(agentSkills.slug, slug));
    expect(row!.lastUpdateCheckAt).toBeNull();

    mockUpToDateFetches([slug]);
    const result = await runSkillUpdateCheckTick(db as never, {
      SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
      SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
    });

    expect(result.checked).toBe(1);
  });

  it('caps how many skills are checked per tick at the batch size', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const slugs = [0, 1, 2].map((i) => `throttle-batch-${Date.now()}-${i}`);
    for (const slug of slugs) await installSkill(db, seed.entityId, slug);

    mockUpToDateFetches(slugs);
    const result = await runSkillUpdateCheckTick(db as never, {
      SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
      SKILL_UPDATE_CHECK_BATCH_SIZE: 2,
    });

    expect(result.checked).toBe(2);
  });

  it('a rate-limit hit stops the rest of the batch for this tick', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const slug = `throttle-ratelimit-${Date.now()}`;
    await installSkill(db, seed.entityId, slug);

    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === `https://clawhub.ai/api/v1/download?slug=${slug}`) {
        return new Response('', { status: 403 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runSkillUpdateCheckTick(db as never, {
      SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
      SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
    });

    expect(result.rateLimited).toBe(true);
    expect(result.checked).toBe(0);

    const [after] = await db.select().from(agentSkills).where(eq(agentSkills.slug, slug));
    expect(after!.lastUpdateCheckAt).toBeNull();
  });

  it('an unparseable-source skill is skipped without aborting the rest of the batch, and is stamped (m3)', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const goodSlug = `throttle-mixed-good-${Date.now()}`;
    await installSkill(db, seed.entityId, goodSlug);

    // A broken row alongside the healthy one — must not stop processing.
    const badSlug = `throttle-mixed-bad-${Date.now()}`;
    await db.insert(agentSkills).values({
      entityId: seed.entityId,
      slug: badSlug,
      name: 'bad',
      content: 'x',
      defaultContent: 'x',
      isCommunity: true,
      source: 'not a url or repo',
    });

    mockUpToDateFetches([goodSlug]);
    const before = Date.now();
    const result = await runSkillUpdateCheckTick(db as never, {
      SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
      SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
    });

    expect(result.checked).toBe(1);
    expect(result.rateLimited).toBe(false);

    // m3 (Opus review): the unparseable row IS stamped checked-now — it must
    // not re-consume a batch slot on every single tick forever.
    const [badRow] = await db.select().from(agentSkills).where(eq(agentSkills.slug, badSlug));
    expect(badRow!.lastUpdateCheckAt).not.toBeNull();
    expect(badRow!.lastUpdateCheckAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('M1: a raw network error on one skill does not block the rest of the batch, and the errored skill is stamped', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const badSlug = `throttle-network-bad-${Date.now()}`;
    const goodSlug = `throttle-network-good-${Date.now()}`;
    await installSkill(db, seed.entityId, badSlug);
    await installSkill(db, seed.entityId, goodSlug);

    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === `https://clawhub.ai/api/v1/download?slug=${badSlug}`) {
        // A raw, unwrapped network failure — never a SkillFetchError. Node's
        // fetch surfaces DNS/ECONNRESET/TLS failures exactly like this.
        throw new TypeError('fetch failed');
      }
      if (url === `https://clawhub.ai/api/v1/download?slug=${goodSlug}`) {
        const buf = makeZip([['SKILL.md', `---\nname: ${goodSlug}\ndescription: d\n---\nHello`]]);
        return new Response(new Uint8Array(buf), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const before = Date.now();
    const result = await runSkillUpdateCheckTick(db as never, {
      SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
      SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
    });

    // The good skill was still processed as a real check; the bad one is
    // counted separately and did NOT abort the batch (rateLimited stays false).
    expect(result.checked).toBe(1);
    expect(result.errored).toBe(1);
    expect(result.rateLimited).toBe(false);

    const [badRow] = await db.select().from(agentSkills).where(eq(agentSkills.slug, badSlug));
    expect(badRow!.lastUpdateCheckAt).not.toBeNull();
    expect(badRow!.lastUpdateCheckAt!.getTime()).toBeGreaterThanOrEqual(before);

    const [goodRow] = await db.select().from(agentSkills).where(eq(agentSkills.slug, goodSlug));
    expect(goodRow!.lastUpdateCheckAt).not.toBeNull();
  });

  it('M1(c): due skills are checked oldest-first (ORDER BY last_update_check_at ASC NULLS FIRST)', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const olderSlug = `throttle-order-older-${Date.now()}`;
    const newerSlug = `throttle-order-newer-${Date.now()}`;
    await installSkill(db, seed.entityId, olderSlug);
    await installSkill(db, seed.entityId, newerSlug);

    // Both are due (interval elapsed), but olderSlug was checked longer ago.
    await db
      .update(agentSkills)
      .set({ lastUpdateCheckAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
      .where(eq(agentSkills.slug, olderSlug));
    await db
      .update(agentSkills)
      .set({ lastUpdateCheckAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(agentSkills.slug, newerSlug));

    // Batch size 1: only ONE of the two gets checked this tick — it must be
    // the older one.
    const seen: string[] = [];
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      for (const slug of [olderSlug, newerSlug]) {
        if (url === `https://clawhub.ai/api/v1/download?slug=${slug}`) {
          seen.push(slug);
          const buf = makeZip([['SKILL.md', `---\nname: ${slug}\ndescription: d\n---\nHello`]]);
          return new Response(new Uint8Array(buf), { status: 200 });
        }
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runSkillUpdateCheckTick(db as never, {
      SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
      SKILL_UPDATE_CHECK_BATCH_SIZE: 1,
    });

    expect(result.checked).toBe(1);
    expect(seen).toEqual([olderSlug]);
  });
});
