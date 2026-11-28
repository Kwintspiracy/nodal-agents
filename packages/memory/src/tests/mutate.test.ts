// mutate.test.ts — mutateMemory, the one function that changes a fact after
// it was saved. Every assertion reads the rows back (agent_memory and
// agent_memory_versions), never a call count.
//
//   1. "the row I read": a change prepared on version N while the owner moved
//      the fact to N+1 is refused, and the owner's text stays;
//   2. the owner's marks (written by the owner, pinned) hold against EVERY
//      actor that is not the owner, for EVERY kind of change, and the owner
//      can still change them;
//   3. every change keeps the previous state, with who changed it, and a
//      revert gives back the exact previous text, active again for the query
//      the prompt builder uses;
//   4. a text that becomes active passes the rules of a create (content rules,
//      exact duplicates), and a new text drops the vector of the old one;
//   5. the deterministic archiver goes through the same function.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentMemory, agentMemoryVersions, agents, eq, sql } from '@nodal-agents/db';
import { mutateMemory, listMemoryVersions, latestMemoryVersions } from '../mutate';
import type { MemoryActor, MemoryChange } from '../mutate';
import { transitionMemoryLifecycle } from '../curator';
import { selectMemoriesForInjection } from '../inject';
import { computeFactHash } from '../hash';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let otherAgentId: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  const [other] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Other',
      slug: `other-${Date.now()}`,
      personality: 'p',
    })
    .returning({ id: agents.id });
  otherAgentId = other!.id;
});

beforeEach(async () => {
  await db.delete(agentMemoryVersions);
  await db.delete(agentMemory);
});

async function insertFact(o: {
  fact: string;
  source?: 'agent' | 'reflection' | 'manual';
  importance?: number;
  importanceLocked?: boolean;
  archived?: boolean;
  createdAt?: Date;
  embedding?: number[];
}): Promise<string> {
  const [row] = await db
    .insert(agentMemory)
    .values({
      entityId: seed.entityId,
      agentId: o.source === 'manual' ? null : seed.agentId,
      fact: o.fact,
      factHash: computeFactHash(o.fact),
      source: o.source ?? 'agent',
      importance: o.importance ?? 3,
      importanceLocked: o.importanceLocked ?? false,
      archived: o.archived ?? false,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      ...(o.embedding ? { embedding: o.embedding } : {}),
    })
    .returning({ id: agentMemory.id });
  return row!.id;
}

async function load(id: string) {
  const [row] = await db.select().from(agentMemory).where(eq(agentMemory.id, id));
  return row!;
}

/** The columns a change may touch: what "byte-identical" compares. */
function state(r: Awaited<ReturnType<typeof load>>) {
  return {
    fact: r.fact,
    category: r.category,
    importance: r.importance,
    importanceLocked: r.importanceLocked,
    archived: r.archived,
    validTo: r.validTo,
    version: r.version,
  };
}

async function injectedFacts(): Promise<string[]> {
  const rows = await selectMemoriesForInjection(db, { entityId: seed.entityId, maxChars: 100_000 });
  return rows.map((m) => m.fact);
}

const NOT_OWNER: Array<{ label: string; actor: () => MemoryActor }> = [
  { label: 'the authoring agent', actor: () => ({ kind: 'agent', agentId: seed.agentId }) },
  { label: 'another agent', actor: () => ({ kind: 'agent', agentId: otherAgentId }) },
  { label: 'the weekly curator', actor: () => ({ kind: 'curator' }) },
  { label: 'the deterministic archiver', actor: () => ({ kind: 'lifecycle' }) },
];

const CHANGES: Array<{ label: string; change: MemoryChange }> = [
  { label: 'edit', change: { kind: 'edit', fact: 'a rewritten text' } },
  { label: 'archive', change: { kind: 'archive' } },
  { label: 'retire', change: { kind: 'retire' } },
  { label: 'rescore', change: { kind: 'rescore', importance: 1 } },
];

describe('mutateMemory: the row I read @cap:se-souvenir/moteur', () => {
  it('refuses a change prepared on version N once the owner moved the fact to N+1; the owner text stays', async () => {
    const id = await insertFact({ fact: 'The invoices go to the accounts address.' });
    const readByCurator = (await load(id)).version;

    const owner = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: readByCurator,
      actor: { kind: 'owner' },
      change: { kind: 'edit', fact: 'The invoices go to the new accounts address since March.' },
    });
    expect(owner.ok).toBe(true);

    const curator = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: readByCurator,
      actor: { kind: 'curator' },
      change: { kind: 'edit', fact: 'Invoices: accounts address.' },
    });
    expect(curator).toMatchObject({ ok: false, reason: 'stale', currentVersion: 2 });

    const row = await load(id);
    expect(row.fact).toBe('The invoices go to the new accounts address since March.');
    expect(row.version).toBe(2);
    // One version kept (the owner's change), none for the refused one.
    const versions = await listMemoryVersions(db, seed.entityId, id);
    expect(versions.map((v) => [v.version, v.changedBy, v.fact])).toEqual([
      [1, 'owner', 'The invoices go to the accounts address.'],
    ]);
  });

  it('a stale read is refused for the owner too: the second of two tabs does not overwrite the first', async () => {
    const id = await insertFact({ fact: 'A fact two tabs show.', source: 'manual' });
    expect(
      (
        await mutateMemory(db, {
          entityId: seed.entityId,
          memoryId: id,
          readVersion: 1,
          actor: { kind: 'owner' },
          change: { kind: 'pin', importance: 5 },
        })
      ).ok,
    ).toBe(true);
    const second = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 1,
      actor: { kind: 'owner' },
      change: { kind: 'archive' },
    });
    expect(second).toMatchObject({ ok: false, reason: 'stale' });
    expect((await load(id)).archived).toBe(false);
  });

  it('a fact of another workspace is not found', async () => {
    const id = await insertFact({ fact: 'A fact of this workspace.' });
    const r = await mutateMemory(db, {
      entityId: '00000000-0000-4000-8000-00000000abcd',
      memoryId: id,
      readVersion: 1,
      actor: { kind: 'owner' },
      change: { kind: 'archive' },
    });
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect((await load(id)).archived).toBe(false);
  });
});

describe("mutateMemory: the owner's marks hold against every other actor @cap:se-souvenir/moteur", () => {
  for (const mark of [
    { label: 'written by the owner', fact: { source: 'manual' as const } },
    { label: 'pinned by the owner', fact: { source: 'agent' as const, importanceLocked: true } },
  ]) {
    for (const who of NOT_OWNER) {
      for (const c of CHANGES) {
        it(`${mark.label}: ${who.label} cannot ${c.label} it`, async () => {
          const id = await insertFact({ fact: `A fact ${mark.label}.`, ...mark.fact });
          const before = state(await load(id));
          const r = await mutateMemory(db, {
            entityId: seed.entityId,
            memoryId: id,
            readVersion: before.version,
            actor: who.actor(),
            change: c.change,
          });
          expect(r).toMatchObject({ ok: false, reason: 'owner_protected' });
          if (!r.ok) expect(r.detail).toContain('only the owner changes it');
          expect(state(await load(id))).toEqual(before);
          expect(await listMemoryVersions(db, seed.entityId, id)).toEqual([]);
        });
      }
    }
  }

  it('an archived fact the owner wrote cannot be restored by an agent', async () => {
    const id = await insertFact({
      fact: 'An archived owner fact.',
      source: 'manual',
      archived: true,
    });
    const r = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 1,
      actor: { kind: 'agent', agentId: seed.agentId },
      change: { kind: 'restore' },
    });
    expect(r).toMatchObject({ ok: false, reason: 'owner_protected' });
    expect((await load(id)).archived).toBe(true);
  });

  it('pin and unpin are the owner marks: no other actor sets or clears them', async () => {
    const id = await insertFact({ fact: 'An agent fact nobody pinned.' });
    for (const who of NOT_OWNER) {
      for (const change of [{ kind: 'pin', importance: 5 }, { kind: 'unpin' }] as const) {
        const r = await mutateMemory(db, {
          entityId: seed.entityId,
          memoryId: id,
          readVersion: 1,
          actor: who.actor(),
          change,
        });
        expect(r).toMatchObject({ ok: false, reason: 'owner_only' });
      }
    }
    const row = await load(id);
    expect([row.importanceLocked, row.importance, row.version]).toEqual([false, 3, 1]);
  });

  it('the owner changes a fact they wrote or pinned, and the change is kept as a version', async () => {
    const manual = await insertFact({ fact: 'Owner wrote this.', source: 'manual' });
    const pinned = await insertFact({ fact: 'Owner pinned this.', importanceLocked: true });
    for (const id of [manual, pinned]) {
      const r = await mutateMemory(db, {
        entityId: seed.entityId,
        memoryId: id,
        readVersion: 1,
        actor: { kind: 'owner' },
        change: { kind: 'archive' },
      });
      expect(r.ok).toBe(true);
      expect((await load(id)).archived).toBe(true);
      const [v] = await listMemoryVersions(db, seed.entityId, id);
      expect([v?.changedBy, v?.action, v?.archived]).toEqual(['owner', 'archive', false]);
    }
  });
});

describe('mutateMemory: the previous version is kept and can be put back @cap:se-souvenir/moteur', () => {
  it('a curator edit keeps the exact previous text; revert gives it back, active for the prompt builder', async () => {
    const original =
      'Deploy procedure: build, tag, push the image, wait for the health check, then switch the ' +
      'traffic. The decisive parameter is in the last line: the health check timeout is 45 s.';
    const id = await insertFact({ fact: original });

    const edit = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 1,
      actor: { kind: 'curator' },
      change: { kind: 'edit', fact: 'Deploy procedure: build, tag, push.' },
      reason: 'distilled',
    });
    expect(edit.ok).toBe(true);
    expect(await injectedFacts()).toEqual(['Deploy procedure: build, tag, push.']);

    const [v] = await listMemoryVersions(db, seed.entityId, id);
    expect(v).toMatchObject({
      version: 1,
      fact: original,
      changedBy: 'curator',
      action: 'edit',
      reason: 'distilled',
      agentId: null,
    });

    const back = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 2,
      actor: { kind: 'owner' },
      change: { kind: 'revert', versionId: v!.id },
    });
    expect(back.ok).toBe(true);
    const row = await load(id);
    expect(row.fact).toBe(original);
    expect(row.factHash).toBe(computeFactHash(original));
    expect(row.version).toBe(3);
    expect(await injectedFacts()).toEqual([original]);
    // The revert is a change too: the pass's text is kept and could come back.
    const versions = await listMemoryVersions(db, seed.entityId, id);
    expect(versions.map((x) => [x.version, x.changedBy, x.action, x.fact])).toEqual([
      [2, 'owner', 'revert', 'Deploy procedure: build, tag, push.'],
      [1, 'curator', 'edit', original],
    ]);
  });

  it('a fact an agent retired is active again for the prompt builder after the owner puts it back', async () => {
    const fact = 'Ask for client approval before sending any quote.';
    const id = await insertFact({ fact });
    const retire = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 1,
      actor: { kind: 'agent', agentId: otherAgentId },
      change: { kind: 'retire' },
      reason: 'superseded',
    });
    expect(retire.ok).toBe(true);
    expect(await injectedFacts()).toEqual([]);
    const [v] = await listMemoryVersions(db, seed.entityId, id);
    expect([v?.changedBy, v?.agentId, v?.action, v?.reason]).toEqual([
      'agent',
      otherAgentId,
      'retire',
      'superseded',
    ]);

    const back = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 2,
      actor: { kind: 'owner' },
      change: { kind: 'revert', versionId: v!.id },
    });
    expect(back.ok).toBe(true);
    expect(await injectedFacts()).toEqual([fact]);
  });

  it('restore reopens the validity window, so a retired fact is read again', async () => {
    const fact = 'The office closes at six.';
    const id = await insertFact({ fact });
    await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 1,
      actor: { kind: 'agent', agentId: seed.agentId },
      change: { kind: 'retire' },
    });
    const r = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 2,
      actor: { kind: 'owner' },
      change: { kind: 'restore' },
    });
    expect(r.ok).toBe(true);
    const row = await load(id);
    expect([row.archived, row.validTo]).toEqual([false, null]);
    expect(await injectedFacts()).toEqual([fact]);
  });

  it('a version of another fact cannot be put back on this one', async () => {
    const a = await insertFact({ fact: 'Fact A.' });
    const b = await insertFact({ fact: 'Fact B.' });
    await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: a,
      readVersion: 1,
      actor: { kind: 'curator' },
      change: { kind: 'edit', fact: 'Fact A, shorter.' },
    });
    const [va] = await listMemoryVersions(db, seed.entityId, a);
    const r = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: b,
      readVersion: 1,
      actor: { kind: 'owner' },
      change: { kind: 'revert', versionId: va!.id },
    });
    expect(r).toMatchObject({ ok: false, reason: 'version_not_found' });
    expect((await load(b)).fact).toBe('Fact B.');
  });

  it('latestMemoryVersions returns the state before the last change of each fact', async () => {
    const a = await insertFact({ fact: 'First text.' });
    const untouched = await insertFact({ fact: 'Never changed.' });
    await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: a,
      readVersion: 1,
      actor: { kind: 'curator' },
      change: { kind: 'edit', fact: 'Second text.' },
    });
    await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: a,
      readVersion: 2,
      actor: { kind: 'lifecycle' },
      change: { kind: 'archive' },
    });
    const latest = await latestMemoryVersions(db, seed.entityId, [a, untouched]);
    expect(latest.has(untouched)).toBe(false);
    expect(latest.get(a)).toMatchObject({
      version: 2,
      fact: 'Second text.',
      changedBy: 'lifecycle',
    });
  });
});

describe('mutateMemory: a text that becomes active passes the rules of a create @cap:se-souvenir/moteur', () => {
  it('an edit to a text another active fact already holds is refused', async () => {
    await insertFact({ fact: 'The client is called Acme.' });
    const id = await insertFact({ fact: 'The client name: Acme Corporation.' });
    const r = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 1,
      actor: { kind: 'curator' },
      change: { kind: 'edit', fact: '  the client is called   ACME. ' },
    });
    expect(r).toMatchObject({ ok: false, reason: 'duplicate' });
    expect((await load(id)).fact).toBe('The client name: Acme Corporation.');
  });

  it('restoring an archived fact whose text is active elsewhere is refused', async () => {
    await insertFact({ fact: 'Reports are due on Fridays.' });
    const id = await insertFact({ fact: 'Reports are due on Fridays.', archived: true });
    const r = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 1,
      actor: { kind: 'owner' },
      change: { kind: 'restore' },
    });
    expect(r).toMatchObject({ ok: false, reason: 'duplicate' });
    expect((await load(id)).archived).toBe(true);
  });

  it('an edit carrying invisible characters is refused by the content rules of a create', async () => {
    const id = await insertFact({ fact: 'A plain fact.' });
    const r = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: id,
      readVersion: 1,
      actor: { kind: 'curator' },
      change: { kind: 'edit', fact: 'A plain​ fact, rewritten.' },
    });
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await load(id)).fact).toBe('A plain fact.');
  });

  it('a new text drops the vector of the old one; an archive keeps it', async () => {
    const vec = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
    const edited = await insertFact({ fact: 'Old wording.', embedding: vec });
    const archived = await insertFact({ fact: 'Archived wording.', embedding: vec });
    await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: edited,
      readVersion: 1,
      actor: { kind: 'curator' },
      change: { kind: 'edit', fact: 'New wording.' },
    });
    await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: archived,
      readVersion: 1,
      actor: { kind: 'curator' },
      change: { kind: 'archive' },
    });
    const rows = await db.execute(
      sql`SELECT id, embedding IS NULL AS no_vec FROM agent_memory WHERE id IN (${edited}, ${archived})`,
    );
    const byId = new Map(
      (rows as unknown as { rows: Array<{ id: string; no_vec: boolean }> }).rows.map((r) => [
        r.id,
        r.no_vec,
      ]),
    );
    expect(byId.get(edited)).toBe(true);
    expect(byId.get(archived)).toBe(false);
  });
});

describe('transitionMemoryLifecycle goes through mutateMemory @cap:se-souvenir/moteur', () => {
  const OLD = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

  it('archives an unused old agent fact with a version naming the archiver; owner-marked ones stay', async () => {
    const unused = await insertFact({ fact: 'Unused old fact.', importance: 1, createdAt: OLD });
    const pinned = await insertFact({
      fact: 'Pinned unused old fact.',
      importance: 1,
      importanceLocked: true,
      createdAt: OLD,
    });
    const manual = await insertFact({
      fact: 'Owner unused old fact.',
      importance: 1,
      source: 'manual',
      createdAt: OLD,
    });
    const pinnedBefore = state(await load(pinned));
    const manualBefore = state(await load(manual));

    const res = await transitionMemoryLifecycle(db, { staleDays: 60, importanceMax: 2 });

    expect(res.archived).toBe(1);
    expect((await load(unused)).archived).toBe(true);
    const [v] = await listMemoryVersions(db, seed.entityId, unused);
    expect([v?.changedBy, v?.action, v?.archived]).toEqual(['lifecycle', 'archive', false]);
    expect(state(await load(pinned))).toEqual(pinnedBefore);
    expect(state(await load(manual))).toEqual(manualBefore);
  });
});
