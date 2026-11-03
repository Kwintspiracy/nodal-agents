// first-spoken-reasoning.test.ts — the FIRST value of "Reasoning when spoken
// to" (#977), written once and then stored.
//
// The orchestrator's decision on the measurement of 2026-11-03: `off` for an
// agent whose model offers it (`reasoningOptionValues` includes 'off'), NULL =
// Auto for any other (mandatory reasoning, a model the catalogue does not
// know). The catalogue lives in TypeScript, not SQL, so migration 0159 cannot
// compute it: a new agent gets it at creation (`createAgentRepo`), the agents
// of a workspace that existed before 0159 get it once, at the runner's boot
// (`writeFirstSpokenReasoningAtBoot`), and the workspace is marked done
// (`entities.spoken_reasoning_written_at`). Never recomputed after.
//
// Assertions read the agent rows (invariant #5).

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { agents, entities, entityLlmKeys, users, eq } from '../index.ts';
import { createAgentRepo, writeFirstSpokenReasoningAtBoot } from '../repos/agents.ts';
import type { AnyDrizzleDb } from '../client.ts';

// openrouter catalogue: levels and Off / mandatory reasoning, no Off / on-off only.
const OFFERS_OFF = 'anthropic/claude-haiku-5.5';
const MANDATORY = 'anthropic/claude-sonnet-5.5';
const ON_OFF = 'mistralai/mistral-large-4-0';
const UNKNOWN = 'nodal-test/not-in-the-catalogue';

let db: TestDb;
let any: AnyDrizzleDb;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  any = db as unknown as AnyDrizzleDb;
});

/** A workspace with an OpenRouter key. `beforeMigration`: its first write is not done. */
async function workspace(beforeMigration: boolean): Promise<{ entityId: string; keyId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `spoken-${randomUUID()}@example.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'Space', slug: `space-${randomUUID().slice(0, 8)}` })
    .returning();
  if (beforeMigration) {
    await db
      .update(entities)
      .set({ spokenReasoningWrittenAt: null })
      .where(eq(entities.id, entity!.id));
  }
  const [key] = await db
    .insert(entityLlmKeys)
    .values({ entityId: entity!.id, provider: 'openrouter', apiKey: '', nickname: 'OR' })
    .returning();
  return { entityId: entity!.id, keyId: key!.id };
}

/** An agent row as it stood before 0159 (inserted directly, effort NULL unless given). */
async function oldAgent(
  space: { entityId: string; keyId: string | null },
  model: string,
  spoken: string | null = null,
): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({
      entityId: space.entityId,
      name: 'Old',
      slug: `old-${randomUUID().slice(0, 8)}`,
      personality: 'Test.',
      llmKeyId: space.keyId,
      model,
      spokenReasoningEffort: spoken,
    })
    .returning();
  return row!.id;
}

async function spokenOf(ids: readonly string[]): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (const id of ids) {
    const [row] = await db
      .select({ spoken: agents.spokenReasoningEffort })
      .from(agents)
      .where(eq(agents.id, id));
    out.push(row!.spoken);
  }
  return out;
}

async function markOf(entityId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: entities.spokenReasoningWrittenAt })
    .from(entities)
    .where(eq(entities.id, entityId));
  return row!.at;
}

describe('the first value of Reasoning when spoken to (#977) @cap:configurer-agent/moteur', () => {
  // Mutation verified: `spokenReasoningEffort` dropped from createAgentRepo's
  // insert → the 'off' case goes red (NULL).
  it('a new agent gets off when its model offers it, Auto otherwise', async () => {
    const space = await workspace(false);
    const created: Record<string, string> = {};
    for (const model of [OFFERS_OFF, MANDATORY, ON_OFF, UNKNOWN]) {
      const r = await createAgentRepo(any, space.entityId, {
        slug: `new-${randomUUID().slice(0, 8)}`,
        name: 'New',
        personality: 'Test.',
        model,
        llmKeyId: space.keyId,
        role: 'agent',
        orchestratorMode: null,
        avatarUrl: null,
        subAgentIds: [],
      });
      if (!('id' in r)) throw new Error('create failed');
      created[model] = r.id;
    }
    const noKey = await createAgentRepo(any, space.entityId, {
      slug: `nokey-${randomUUID().slice(0, 8)}`,
      name: 'No key',
      personality: 'Test.',
      model: OFFERS_OFF,
      llmKeyId: null,
      role: 'agent',
      orchestratorMode: null,
      avatarUrl: null,
      subAgentIds: [],
    });
    if (!('id' in noKey)) throw new Error('create failed');
    expect(
      await spokenOf([
        created[OFFERS_OFF]!,
        created[MANDATORY]!,
        created[ON_OFF]!,
        created[UNKNOWN]!,
        noKey.id,
      ]),
    ).toEqual(['off', null, 'off', null, null]);
  });

  // Mutation verified: the boot write's `'off'` replaced by NULL → red; the
  // workspace claim removed (every boot rewrites) → the second-boot case red.
  it('at the first boot after 0159, the agents of an older workspace get it once', async () => {
    const space = await workspace(true);
    const offersOff = await oldAgent(space, OFFERS_OFF);
    const mandatory = await oldAgent(space, MANDATORY);
    const unknown = await oldAgent(space, UNKNOWN);
    // Set by hand between the migration and this boot: kept as it is.
    const byHand = await oldAgent(space, OFFERS_OFF, 'low');
    expect(await markOf(space.entityId)).toBeNull();

    await writeFirstSpokenReasoningAtBoot(any);

    expect(await spokenOf([offersOff, mandatory, unknown, byHand])).toEqual([
      'off',
      null,
      null,
      'low',
    ]);
    expect(await markOf(space.entityId)).toBeInstanceOf(Date);
  });

  it('a second boot changes nothing, and a value changed by hand is never overwritten', async () => {
    const space = await workspace(true);
    const a = await oldAgent(space, OFFERS_OFF);
    const b = await oldAgent(space, OFFERS_OFF);
    await writeFirstSpokenReasoningAtBoot(any);
    expect(await spokenOf([a, b])).toEqual(['off', 'off']);
    const mark = await markOf(space.entityId);

    // The owner changes both by hand: one to High, one back to Auto.
    await db.update(agents).set({ spokenReasoningEffort: 'high' }).where(eq(agents.id, a));
    await db.update(agents).set({ spokenReasoningEffort: null }).where(eq(agents.id, b));
    // And an agent joins later, on a model that offers Off, with Auto by hand.
    const later = await oldAgent(space, OFFERS_OFF, null);

    await writeFirstSpokenReasoningAtBoot(any);
    await writeFirstSpokenReasoningAtBoot(any);

    expect(await spokenOf([a, b, later])).toEqual(['high', null, null]);
    expect(await markOf(space.entityId)).toEqual(mark);
  });

  it('a workspace created after 0159 is born marked: its agents are never rewritten at boot', async () => {
    const space = await workspace(false);
    expect(await markOf(space.entityId)).toBeInstanceOf(Date);
    const agent = await oldAgent(space, OFFERS_OFF, null);
    await writeFirstSpokenReasoningAtBoot(any);
    expect(await spokenOf([agent])).toEqual([null]);
  });

  it('a key of another workspace says nothing about the model: the agent stays Auto', async () => {
    const space = await workspace(true);
    const other = await workspace(false);
    const agent = await oldAgent({ entityId: space.entityId, keyId: other.keyId }, OFFERS_OFF);
    await writeFirstSpokenReasoningAtBoot(any);
    expect(await spokenOf([agent])).toEqual([null]);
    expect(await markOf(space.entityId)).toBeInstanceOf(Date);
  });
});

// Keeps seedMinimal's import honest for readers grepping the helpers: the
// seeded workspace is created after 0159 in the test schema (marked by default).
describe('the test schema mirrors 0159', () => {
  it('a seeded workspace is born marked', async () => {
    const seed = await seedMinimal(db);
    expect(await markOf(seed.entityId)).toBeInstanceOf(Date);
  });
});
