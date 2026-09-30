// photo-attach.test.ts — attachInboundPhoto only writes the image onto a
// message that is STILL waiting (G1): a job still pending, or — when the
// message went to the conversation's running work (#531) — its entry still in
// that job's inbox. If the run already picked the message up, the out-of-txn
// photo attach must not clobber the in-flight transcript.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, deliverOrStartTurn } from '@nodal-agents/db';
import { agentJobs, conversations } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { writeFile } from 'node:fs/promises';
import type { RunnerDeps } from '../../deps.ts';

// The photo download + filesystem writes are external I/O — stub them so the
// test exercises only the conditional DB write.
vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getTelegramFile: vi.fn(async () => ({ bytes: Buffer.from('fake'), ext: 'jpg' })),
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  };
});

import { attachInboundPhoto } from '../../telegram/handler.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

async function makeJob(status: string): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      task: 'photo',
      chatId: '77',
      status,
      messages: [{ role: 'user', content: 'photo' }],
    })
    .returning({ id: agentJobs.id });
  return job!.id;
}

async function messagesOf(jobId: string): Promise<unknown> {
  const [row] = await db
    .select({ messages: agentJobs.messages })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row?.messages;
}

describe('attachInboundPhoto — conditional on pending (G1)', () => {
  it('attaches the image when the job is still pending', async () => {
    const jobId = await makeJob('pending');
    await attachInboundPhoto({
      entityId: seed.entityId,
      botToken: '123:fake',
      photo: { fileId: 'f1', chatId: '77', text: 'a photo', target: { kind: 'job', jobId } },
      db: db as unknown as RunnerDeps['db'],
    });

    const messages = messagesOf(jobId);
    const str = JSON.stringify(await messages);
    expect(str).toContain('"type":"image"');
    expect(str).toContain('a photo');
  });

  it('does NOT overwrite messages when the job already left pending', async () => {
    const jobId = await makeJob('processing');
    const before = JSON.stringify(await messagesOf(jobId));

    await attachInboundPhoto({
      entityId: seed.entityId,
      botToken: '123:fake',
      photo: { fileId: 'f1', chatId: '77', text: 'a photo', target: { kind: 'job', jobId } },
      db: db as unknown as RunnerDeps['db'],
    });

    const after = JSON.stringify(await messagesOf(jobId));
    expect(after).toBe(before); // untouched — no clobber of the in-flight transcript
    expect(after).not.toContain('"type":"image"');
  });

  it('a photo sent while the conversation works (#531): upgrades its entry in the running job’s inbox, file named after that job', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'telegram', chatId: '77' })
      .returning({ id: conversations.id });
    const [head] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '77',
        conversationId: conv!.id,
        task: 'Fais-moi un portrait',
        status: 'processing',
      })
      .returning({ id: agentJobs.id });
    const turn = await deliverOrStartTurn(db as unknown as AnyDrizzleDb, {
      entityId: seed.entityId,
      conversationId: conv!.id,
      message: { task: 'dans ce style', content: 'dans ce style' },
      start: {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        conversationId: conv!.id,
        task: 'dans ce style',
      },
    });
    if (turn.kind !== 'delivered') throw new Error('expected a delivery');
    vi.mocked(writeFile).mockClear();

    const path = await attachInboundPhoto({
      entityId: seed.entityId,
      botToken: '123:fake',
      photo: {
        fileId: 'f1',
        chatId: '77',
        text: 'dans ce style',
        target: { kind: 'inbox', headJobId: head!.id, entryId: turn.entryId },
      },
      db: db as unknown as RunnerDeps['db'],
    });

    expect(path.split('\\').join('/').endsWith(`/${head!.id}.${turn.entryId}.jpg`)).toBe(true);
    const [row] = await db
      .select({ inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(eq(agentJobs.id, head!.id));
    expect(row!.inbox.map((e) => e.content)).toEqual([
      [
        { type: 'text', text: 'dans ce style' },
        { type: 'image', image: path },
      ],
    ]);
  });
});
