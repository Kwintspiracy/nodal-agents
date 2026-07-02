// curator.test.ts — Tier-2 memory curator repo helpers (Brick 4).
// Phase 1 deterministic archival + provenance-guarded edit/archive.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory, eq } from '@nodal-agents/db';
import {
  transitionMemoryLifecycle,
  archiveAgentMemory,
  updateAgentMemoryFact,
  updateAgentMemoryImportance,
} from '../curator';
import { computeFactHash } from '../hash';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

const OLD = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000); // 200 days ago
const RECENT = new Date();

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

async function insertFact(o: {
  fact: string;
  source: 'agent' | 'reflection' | 'manual';
  importance: number;
  accessCount?: number;
  createdAt?: Date;
  importanceLocked?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(agentMemory)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      fact: o.fact,
      source: o.source,
      importance: o.importance,
      accessCount: o.accessCount ?? 0,
      archived: false,
      createdAt: o.createdAt ?? OLD,
      importanceLocked: o.importanceLocked ?? false,
    })
    .returning({ id: agentMemory.id });
  return row!.id as string;
}

async function isArchived(id: string): Promise<boolean> {
  const [r] = await db
    .select({ archived: agentMemory.archived })
    .from(agentMemory)
    .where(eq(agentMemory.id, id));
  return r?.archived === true;
}

describe('transitionMemoryLifecycle — deterministic usage-based archival', () => {
  it('archives ONLY agent-authored, low-importance, never-used, old facts', async () => {
    await db.delete(agentMemory);
    const archivable = await insertFact({
      fact: 'agent guess never used',
      source: 'agent',
      importance: 2,
      accessCount: 0,
      createdAt: OLD,
    });
    const highImportance = await insertFact({
      fact: 'critical agent fact',
      source: 'agent',
      importance: 5,
      accessCount: 0,
      createdAt: OLD,
    });
    const used = await insertFact({
      fact: 'agent fact that proved useful',
      source: 'agent',
      importance: 2,
      accessCount: 3,
      createdAt: OLD,
    });
    const recent = await insertFact({
      fact: 'recent agent fact',
      source: 'agent',
      importance: 2,
      accessCount: 0,
      createdAt: RECENT,
    });
    const userEntered = await insertFact({
      fact: 'user-entered low fact',
      source: 'manual',
      importance: 1,
      accessCount: 0,
      createdAt: OLD,
    });

    const res = await transitionMemoryLifecycle(db, { staleDays: 60, importanceMax: 2 });

    expect(res.archived).toBe(1);
    expect(await isArchived(archivable)).toBe(true);
    // Everything else is spared — high-importance, used, recent, and user-entered.
    expect(await isArchived(highImportance)).toBe(false);
    expect(await isArchived(used)).toBe(false);
    expect(await isArchived(recent)).toBe(false);
    expect(await isArchived(userEntered)).toBe(false);
  });
});

describe('archiveAgentMemory — provenance-guarded', () => {
  it('archives an agent fact but REFUSES a user-entered (manual) one', async () => {
    await db.delete(agentMemory);
    const agentFact = await insertFact({ fact: 'agent fact', source: 'agent', importance: 3 });
    const userFact = await insertFact({ fact: 'user fact', source: 'manual', importance: 3 });

    expect(await archiveAgentMemory(db, seed.entityId, agentFact)).toEqual({ ok: true });
    expect(await isArchived(agentFact)).toBe(true);

    expect(await archiveAgentMemory(db, seed.entityId, userFact)).toEqual({
      error: 'not_agent_memory',
    });
    expect(await isArchived(userFact)).toBe(false); // untouched
  });

  it('returns not_found for a missing id', async () => {
    const res = await archiveAgentMemory(db, seed.entityId, '00000000-0000-0000-0000-0000000000ff');
    expect(res).toEqual({ error: 'not_found' });
  });
});

describe('updateAgentMemoryFact — provenance-guarded distill/merge', () => {
  it('distills an agent fact and recomputes its hash, but REFUSES a manual one', async () => {
    await db.delete(agentMemory);
    const blob = await insertFact({
      fact: 'X'.repeat(2000),
      source: 'agent',
      importance: 5,
    });
    const userFact = await insertFact({ fact: 'user fact', source: 'manual', importance: 3 });

    const distilled = 'For z_image, load workflows/Z_Image_BaseCustom.json (port 8000).';
    expect(await updateAgentMemoryFact(db, seed.entityId, blob, distilled)).toEqual({ ok: true });

    const [row] = await db
      .select({ fact: agentMemory.fact, factHash: agentMemory.factHash })
      .from(agentMemory)
      .where(eq(agentMemory.id, blob));
    expect(row?.fact).toBe(distilled);
    expect(row?.factHash).toBe(computeFactHash(distilled)); // hash kept correct for dedup

    expect(await updateAgentMemoryFact(db, seed.entityId, userFact, 'hacked')).toEqual({
      error: 'not_agent_memory',
    });
  });
});

describe('updateAgentMemoryImportance — usage-driven re-scoring', () => {
  it('changes the importance of an agent fact but REFUSES a user-entered (manual) one', async () => {
    await db.delete(agentMemory);
    const agentFact = await insertFact({
      fact: 'agent fact often used',
      source: 'agent',
      importance: 2,
      accessCount: 12,
    });
    const userFact = await insertFact({
      fact: 'user fact',
      source: 'manual',
      importance: 3,
    });

    expect(await updateAgentMemoryImportance(db, seed.entityId, agentFact, 5)).toEqual({
      ok: true,
    });
    const [row] = await db
      .select({ importance: agentMemory.importance })
      .from(agentMemory)
      .where(eq(agentMemory.id, agentFact));
    expect(row?.importance).toBe(5);

    expect(await updateAgentMemoryImportance(db, seed.entityId, userFact, 1)).toEqual({
      error: 'not_agent_memory',
    });
    const [userRow] = await db
      .select({ importance: agentMemory.importance })
      .from(agentMemory)
      .where(eq(agentMemory.id, userFact));
    expect(userRow?.importance).toBe(3); // untouched
  });

  it('returns not_found for a missing id', async () => {
    const res = await updateAgentMemoryImportance(
      db,
      seed.entityId,
      '00000000-0000-0000-0000-0000000000ff',
      3,
    );
    expect(res).toEqual({ error: 'not_found' });
  });

  it('refuses to re-score a user-locked fact, leaving importance untouched', async () => {
    await db.delete(agentMemory);
    const lockedFact = await insertFact({
      fact: 'user-pinned agent fact',
      source: 'agent',
      importance: 5,
      accessCount: 0,
      importanceLocked: true,
    });

    expect(await updateAgentMemoryImportance(db, seed.entityId, lockedFact, 1)).toEqual({
      error: 'importance_locked',
    });
    const [row] = await db
      .select({ importance: agentMemory.importance })
      .from(agentMemory)
      .where(eq(agentMemory.id, lockedFact));
    expect(row?.importance).toBe(5); // untouched — the user's pin wins
  });

  it('rejects an out-of-range or non-integer importance without touching the row', async () => {
    await db.delete(agentMemory);
    const agentFact = await insertFact({ fact: 'agent fact', source: 'agent', importance: 3 });

    expect(await updateAgentMemoryImportance(db, seed.entityId, agentFact, 6)).toEqual({
      error: 'invalid_importance',
    });
    expect(await updateAgentMemoryImportance(db, seed.entityId, agentFact, 0)).toEqual({
      error: 'invalid_importance',
    });
    expect(await updateAgentMemoryImportance(db, seed.entityId, agentFact, 2.5)).toEqual({
      error: 'invalid_importance',
    });

    const [row] = await db
      .select({ importance: agentMemory.importance })
      .from(agentMemory)
      .where(eq(agentMemory.id, agentFact));
    expect(row?.importance).toBe(3); // untouched
  });
});
