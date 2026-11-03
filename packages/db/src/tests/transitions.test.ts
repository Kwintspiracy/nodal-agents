// transitions.test.ts — les portes des deux transitions poussées (#944, revue
// de #956), et la remise de leurs annonces APRÈS le COMMIT.
//
// Ce qui se prouve, sur une vraie base (PGlite) et un écouteur qui note ce
// qu'il reçoit : une porte n'annonce que les lignes que SA garde a laissées
// passer ; hors transaction l'annonce part tout de suite ; dans une
// transaction `inTransaction`, elle attend le COMMIT et disparaît sur un
// ROLLBACK ; un point de sauvegarde rejoint la transaction d'en dessous ; dans
// une transaction que personne ne suit, rien ne part et l'écouteur reçoit
// `lost` ; un processus sans écouteur ne casse rien.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { agentJobs, approvalRequests } from '../schema/index.ts';
import {
  announceTransitions,
  cancelJobs,
  decidePendingRequest,
  expirePendingRequests,
  inTransaction,
  listenToTransitions,
  type Transitions,
} from '../repos/transitions.ts';
import { cancelJobTree } from '../repos/conversation-runs.ts';
import type { AnyDrizzleDb } from '../client.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
const asDb = (): AnyDrizzleDb => db as unknown as AnyDrizzleDb;

let received: Transitions[] = [];
let lost: string[] = [];
let unlisten: () => void = () => {};

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

beforeEach(() => {
  received = [];
  lost = [];
  unlisten = listenToTransitions({
    committed: async (_db, t) => {
      received.push({
        endedJobIds: [...t.endedJobIds],
        settledRequestIds: [...t.settledRequestIds],
      });
    },
    lost: (reason) => lost.push(reason),
  });
});

afterEach(() => unlisten());

async function job(status: string, parentJobId?: string): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 't',
      status,
      ...(parentJobId ? { parentJobId } : {}),
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function request(jobId: string, status = 'pending'): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId,
      agentId: seed.agentId,
      toolName: 'run_command',
      toolInput: { command: 'ls', purpose: 'look' },
      kind: 'approval',
      status,
    })
    .returning({ id: approvalRequests.id });
  return row!.id;
}

const ended = (): string[] => received.flatMap((t) => [...t.endedJobIds]);
const settled = (): string[] => received.flatMap((t) => [...t.settledRequestIds]);

describe('les portes des transitions poussées (#944) @cap:suivre-execution/moteur', () => {
  it("cancelJobs n'annule et n'annonce que les jobs que sa garde laisse passer", async () => {
    const live = await job('processing');
    const done = await job('completed');
    const waiting = await job('awaiting_delegation');

    const ids = await cancelJobs(asDb(), { ids: [live, done, waiting], onlyFrom: ['processing'] });

    expect(ids).toEqual([live]);
    expect(ended()).toEqual([live]);
    const rows = await db.select({ id: agentJobs.id, status: agentJobs.status }).from(agentJobs);
    expect(rows.find((r) => r.id === done)?.status).toBe('completed');
    expect(rows.find((r) => r.id === waiting)?.status).toBe('awaiting_delegation');
    // Rejouée : plus rien ne vit, rien n'est annoncé.
    await cancelJobs(asDb(), { ids: [live] });
    expect(ended()).toEqual([live]);
  });

  it("expirePendingRequests et decidePendingRequest n'annoncent que ce qui a quitté `pending`", async () => {
    const j = await job('awaiting_approval');
    const open = await request(j);
    const already = await request(j, 'approved');
    const rows = await expirePendingRequests(asDb(), {
      where: eq(approvalRequests.jobId, j),
      resolvedBy: 'test',
    });
    expect(rows.map((r) => r.id)).toEqual([open]);
    expect(settled()).toEqual([open]);

    const another = await request(j);
    expect(
      await decidePendingRequest(asDb(), {
        id: another,
        status: 'approved',
        resolvedBy: 'api',
        notes: null,
        answer: null,
        response: null,
      }),
    ).toBe(true);
    // Le second arrivé perd, et ne dit rien.
    expect(
      await decidePendingRequest(asDb(), {
        id: another,
        status: 'rejected',
        resolvedBy: 'api',
        notes: null,
        answer: null,
        response: null,
      }),
    ).toBe(false);
    expect(settled()).toEqual([open, another]);
    expect(already).not.toBe(open);
  });

  it('dans inTransaction : rien avant le COMMIT, tout après ; rien sur un ROLLBACK', async () => {
    const a = await job('processing');
    let duringWork = -1;
    await inTransaction(asDb(), async (tx) => {
      await cancelJobs(tx, { ids: [a] });
      duringWork = received.length;
    });
    expect(duringWork).toBe(0);
    expect(ended()).toEqual([a]);

    const b = await job('processing');
    await expect(
      inTransaction(asDb(), async (tx) => {
        await cancelJobs(tx, { ids: [b] });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(ended()).toEqual([a]);
    const [row] = await db
      .select({ s: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, b));
    expect(row?.s).toBe('processing');
  });

  it("un point de sauvegarde rejoint la transaction d'en dessous : une remise, à SON commit", async () => {
    const head = await job('processing');
    const child = await job('awaiting_approval', head);
    const req = await request(child);
    let afterInner = -1;
    await inTransaction(asDb(), async (tx) => {
      // `cancelJobTree` ouvre lui-même un `inTransaction` : un point de sauvegarde ici.
      await cancelJobTree(tx, { entityId: seed.entityId, jobId: head });
      afterInner = received.length;
    });
    expect(afterInner).toBe(0);
    expect(received).toHaveLength(1);
    expect([...ended()].sort()).toEqual([head, child].sort());
    expect(settled()).toEqual([req]);
  });

  it('dans une transaction que personne ne suit : aucun fait, `lost`', async () => {
    const j = await job('processing');
    await db.transaction(async (tx) => {
      await cancelJobs(tx as unknown as AnyDrizzleDb, { ids: [j] });
    });
    expect(received).toEqual([]);
    expect(lost).toEqual(['transaction_not_followed']);
  });

  it('sans écouteur dans le processus, une porte écrit quand même et ne lève pas', async () => {
    unlisten();
    const j = await job('processing');
    await expect(cancelJobs(asDb(), { ids: [j] })).resolves.toEqual([j]);
    await expect(announceTransitions(asDb(), { endedJobIds: [j] })).resolves.toBeUndefined();
    expect(received).toEqual([]);
  });
});
