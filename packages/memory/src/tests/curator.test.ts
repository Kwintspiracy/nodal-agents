// curator.test.ts — Tier-2 memory curator repo helpers (Brick 4).
// Phase 1 deterministic archival (the guarded changes: mutate.test.ts).

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory, eq } from '@nodal-agents/db';
import { transitionMemoryLifecycle } from '../curator';
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

  it('NEVER archives a user-pinned fact, even when otherwise archivable (H1)', async () => {
    await db.delete(agentMemory);
    // Identical to the archivable case above (agent, low importance, unused, old)
    // EXCEPT the user pinned it — the deterministic sweep must honor the pin, or
    // it silently regresses the 0.7.0 star/pin feature.
    const pinned = await insertFact({
      fact: 'agent fact the user pinned',
      source: 'agent',
      importance: 2,
      accessCount: 0,
      createdAt: OLD,
      importanceLocked: true,
    });

    const res = await transitionMemoryLifecycle(db, { staleDays: 60, importanceMax: 2 });

    expect(res.archived).toBe(0);
    expect(await isArchived(pinned)).toBe(false);
  });
});
