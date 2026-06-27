// search-history.test.ts — search_history tool: full-text episodic recall over
// past jobs. Spinning up the test DB also applies migration 0050 (search_text +
// generated search_tsv + GIN), so this doubles as proof the FTS migration works
// on pglite. Entity-scoping is the same eq(entityId) WHERE as query_memory.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentJobs } from '@nodal-agents/db';
import { searchHistoryTool } from '../builtin/search-history';
import type { ToolContext } from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);

  // Past jobs forming the searchable corpus. search_tsv is GENERATED from
  // search_text, so just setting search_text makes the row findable.
  await db.insert(agentJobs).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      status: 'completed',
      task: 'génère une image de rousse avec z_image',
      searchText:
        'génère une image de rousse avec z_image. ComfyUI workflow Z_Image_BaseCustom on port 8000, lora famegrid_spice_v2.',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      status: 'completed',
      task: 'list the Airtable bases',
      searchText: 'list the Airtable bases. Found base appXYZ named Clients.',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      status: 'completed',
      task: 'plan a hike',
      searchText: 'plan a hike this weekend in the mountains.',
    },
    // Two jobs sharing a unique term, for the limit test.
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      status: 'completed',
      task: 'zephyr alpha run',
      searchText: 'zephyr alpha run done.',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      status: 'completed',
      task: 'zephyr beta run',
      searchText: 'zephyr beta run done.',
    },
  ]);
});

function makeCtx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

describe('search_history — full-text episodic search', () => {
  it('finds the past job whose transcript matches the query, with a highlighted snippet', async () => {
    const hits = await searchHistoryTool.execute({ query: 'image port' }, makeCtx());
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.task).toContain('z_image');
    // ts_headline wraps matched terms in « » (StartSel/StopSel)
    expect(hits[0]?.snippet).toMatch(/«[^»]+»/);
  });

  it('returns only matching jobs, not unrelated ones', async () => {
    const hits = await searchHistoryTool.execute({ query: 'airtable' }, makeCtx());
    expect(hits.length).toBe(1);
    expect(hits[0]?.task.toLowerCase()).toContain('airtable');
    expect(hits.some((h) => h.task.includes('hike'))).toBe(false);
  });

  it('returns nothing for a query absent from every transcript', async () => {
    const hits = await searchHistoryTool.execute({ query: 'kubernetes deployment' }, makeCtx());
    expect(hits).toEqual([]);
  });

  it('respects the limit (2 matching jobs, limit 1 → 1)', async () => {
    const all = await searchHistoryTool.execute({ query: 'zephyr' }, makeCtx());
    expect(all.length).toBe(2);
    const limited = await searchHistoryTool.execute({ query: 'zephyr', limit: 1 }, makeCtx());
    expect(limited.length).toBe(1);
  });

  it('reports which agent ran the matched job', async () => {
    const hits = await searchHistoryTool.execute({ query: 'airtable' }, makeCtx());
    expect(hits[0]?.agent).toBeTruthy(); // joined from agents.slug
  });
});
