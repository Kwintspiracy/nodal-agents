// link-helpers.test.ts — resolveAgentId/resolveConnectorId LIKE-wildcard guard.
//
// F-10 (audit #2): these resolvers intend an EXACT (case-insensitive) name
// match — same semantics as the `slug` `eq()` branch they're OR'd with. Before
// the fix, an unescaped `slugOrName` was used directly as an ILIKE pattern, so
// a value containing `%` or `_` could match an unintended row within the
// entity instead of failing to match (or matching only the intended exact
// name).

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, connectors } from '@nodal-agents/db';
import { resolveAgentId, resolveConnectorId } from '../builtin/meta-ops/link-helpers.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

describe('resolveAgentId — F-10 LIKE-wildcard guard', () => {
  it('resolves an existing agent by its exact (case-insensitive) name', async () => {
    const [decoy] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Sales Bot',
        slug: `sales-bot-${crypto.randomUUID()}`,
        personality: 'p',
      })
      .returning();
    if (!decoy) throw new Error('failed to seed decoy agent');

    const id = await resolveAgentId(db as never, seed.entityId, 'sales bot');
    expect(id).toBe(decoy.id);
  });

  it('a "%" wildcard in slugOrName does NOT match an unrelated agent name', async () => {
    // Seed an agent whose name would be matched by a naive ILIKE('Sales%')
    // pattern even though "Sales%" itself is not that agent's name.
    const [target] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Sales Reporting Assistant',
        slug: `sales-reporting-${crypto.randomUUID()}`,
        personality: 'p',
      })
      .returning();
    if (!target) throw new Error('failed to seed target agent');

    const id = await resolveAgentId(db as never, seed.entityId, 'Sales%');
    // Must NOT resolve to the unrelated "Sales Reporting Assistant" row —
    // "Sales%" is not that agent's literal name, so no match at all.
    expect(id).not.toBe(target.id);
    expect(id).toBeNull();
  });

  it('an "_" wildcard in slugOrName does NOT match an unrelated agent name', async () => {
    const [target] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'SalesXBot',
        slug: `salesxbot-${crypto.randomUUID()}`,
        personality: 'p',
      })
      .returning();
    if (!target) throw new Error('failed to seed target agent');

    // "Sales_Bot" naively matches "SalesXBot" under raw ILIKE (any single
    // char in place of "_") — must not resolve once escaped.
    const id = await resolveAgentId(db as never, seed.entityId, 'Sales_Bot');
    expect(id).not.toBe(target.id);
    expect(id).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    const id = await resolveAgentId(db as never, seed.entityId, 'no-such-agent-xyz');
    expect(id).toBeNull();
  });
});

describe('resolveConnectorId — F-10 LIKE-wildcard guard', () => {
  it('a "%" wildcard in slugOrName does NOT match an unrelated connector name', async () => {
    const [target] = await db
      .insert(connectors)
      .values({
        entityId: seed.entityId,
        name: 'Gmail Personal',
        slug: `gmail-personal-${crypto.randomUUID()}`,
        authType: 'api_key',
      })
      .returning();
    if (!target) throw new Error('failed to seed target connector');

    const id = await resolveConnectorId(db as never, seed.entityId, 'Gmail%');
    expect(id).not.toBe(target.id);
    expect(id).toBeNull();
  });

  it('resolves an existing connector by its exact (case-insensitive) name', async () => {
    const [decoy] = await db
      .insert(connectors)
      .values({
        entityId: seed.entityId,
        name: 'Notion Workspace',
        slug: `notion-workspace-${crypto.randomUUID()}`,
        authType: 'oauth2',
      })
      .returning();
    if (!decoy) throw new Error('failed to seed decoy connector');

    const id = await resolveConnectorId(db as never, seed.entityId, 'notion workspace');
    expect(id).toBe(decoy.id);
  });
});
