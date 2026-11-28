// memory-actions.test.ts — the Memory page's own changes go through the same
// guarded function as every other path (#1144), read back IN THE DATABASE.
//
//   - archive, restore, pin and unpin each keep the previous state as a
//     version, attributed to the owner;
//   - each states the version the page showed: a page left open while the
//     fact changed cannot overwrite the newer state;
//   - a change made by an automatic pass is listed with the previous text, and
//     putting it back gives the exact text, active again.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentMemory, agentMemoryVersions, eq } from '@nodal-agents/db';
import { mutateMemory, selectMemoriesForInjection } from '@nodal-agents/memory';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
});

beforeEach(async () => {
  await testDb.delete(agentMemoryVersions);
  await testDb.delete(agentMemory);
});

async function insertFact(fact: string, o: { source?: 'agent' | 'manual' } = {}) {
  const [row] = await testDb
    .insert(agentMemory)
    .values({
      entityId: seed.entityId,
      agentId: o.source === 'manual' ? null : seed.agentId,
      fact,
      source: o.source ?? 'agent',
      importance: 3,
    })
    .returning();
  return row!;
}

async function load(id: string) {
  const [row] = await testDb.select().from(agentMemory).where(eq(agentMemory.id, id));
  return row!;
}

async function versionsOf(id: string) {
  return testDb
    .select()
    .from(agentMemoryVersions)
    .where(eq(agentMemoryVersions.memoryId, id))
    .orderBy(agentMemoryVersions.version);
}

describe('Memory page actions go through mutateMemory (#1144) @cap:se-souvenir/ecran', () => {
  it('archive, restore, pin and unpin each keep a version attributed to the owner', async () => {
    const {
      archiveMemoryAction,
      unarchiveMemoryAction,
      updateMemoryImportanceAction,
      unpinMemoryImportanceAction,
    } = await import('../actions.ts');
    const m = await insertFact('The team ships on Thursdays.');

    expect((await archiveMemoryAction(m.id, 1)).ok).toBe(true);
    expect((await unarchiveMemoryAction(m.id, 2)).ok).toBe(true);
    expect((await updateMemoryImportanceAction(m.id, 5, 3)).ok).toBe(true);
    expect((await unpinMemoryImportanceAction(m.id, 4)).ok).toBe(true);

    const row = await load(m.id);
    expect([row.archived, row.importance, row.importanceLocked, row.version]).toEqual([
      false,
      5,
      false,
      5,
    ]);
    expect(
      (await versionsOf(m.id)).map((v) => [v.version, v.changedBy, v.action, v.archived]),
    ).toEqual([
      [1, 'owner', 'archive', false],
      [2, 'owner', 'restore', true],
      [3, 'owner', 'pin', false],
      [4, 'owner', 'unpin', false],
    ]);
  });

  it('the owner changes a fact they wrote: the page acts as the owner', async () => {
    const { archiveMemoryAction } = await import('../actions.ts');
    const m = await insertFact('Owner wrote this.', { source: 'manual' });
    expect((await archiveMemoryAction(m.id, 1)).ok).toBe(true);
    expect((await load(m.id)).archived).toBe(true);
  });

  it('a page showing version N cannot overwrite a fact that moved to N+1', async () => {
    const { archiveMemoryAction, updateMemoryImportanceAction } = await import('../actions.ts');
    const m = await insertFact('Lunch is at noon.');
    // The weekly pass rewrites it while the page is open on version 1.
    const pass = await mutateMemory(testDb, {
      entityId: seed.entityId,
      memoryId: m.id,
      readVersion: 1,
      actor: { kind: 'curator' },
      change: { kind: 'edit', fact: 'Lunch: noon.' },
    });
    expect(pass.ok).toBe(true);

    const archive = await archiveMemoryAction(m.id, 1);
    expect(archive.ok).toBe(false);
    if (!archive.ok) expect(archive.code).toBe('conflict');
    const pin = await updateMemoryImportanceAction(m.id, 5, 1);
    expect(pin.ok).toBe(false);
    const row = await load(m.id);
    expect([row.fact, row.archived, row.importanceLocked, row.version]).toEqual([
      'Lunch: noon.',
      false,
      false,
      2,
    ]);
  });

  it('a change by an automatic pass is listed with the previous text, and putting it back restores it exactly', async () => {
    const { listMemoriesAction, restoreMemoryVersionAction } = await import('../actions.ts');
    const original = 'Backups run at 2am and are kept 30 days; the restore key is in the vault.';
    const m = await insertFact(original);
    const untouched = await insertFact('A fact nothing changed.');
    await mutateMemory(testDb, {
      entityId: seed.entityId,
      memoryId: m.id,
      readVersion: 1,
      actor: { kind: 'curator' },
      change: { kind: 'edit', fact: 'Backups run at 2am.' },
    });

    const listed = await listMemoriesAction({ archived: false, pageSize: 50 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const changed = listed.data.items.find((i) => i.id === m.id);
    expect(changed?.version).toBe(2);
    expect(changed?.lastChange).toMatchObject({
      changedBy: 'curator',
      action: 'edit',
      previousFact: original,
    });
    expect(listed.data.items.find((i) => i.id === untouched.id)?.lastChange).toBeNull();

    const back = await restoreMemoryVersionAction(m.id, changed!.lastChange!.versionId, 2);
    expect(back.ok).toBe(true);
    expect((await load(m.id)).fact).toBe(original);
    const injected = await selectMemoriesForInjection(testDb, {
      entityId: seed.entityId,
      maxChars: 10_000,
    });
    expect(injected.map((f) => f.fact)).toContain(original);

    // Once the owner put it back, the last change is the owner's: no prompt to undo again.
    const again = await listMemoriesAction({ archived: false, pageSize: 50 });
    expect(again.ok && again.data.items.find((i) => i.id === m.id)?.lastChange).toBeNull();
  });

  it('an invalid id or version is refused before anything is read', async () => {
    const { archiveMemoryAction, restoreMemoryVersionAction } = await import('../actions.ts');
    const m = await insertFact('Validation fact.');
    for (const r of [
      await archiveMemoryAction('bad', 1),
      await archiveMemoryAction(m.id, 0),
      await restoreMemoryVersionAction(m.id, 'bad', 1),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('validation_failed');
    }
    expect((await load(m.id)).version).toBe(1);
  });
});
