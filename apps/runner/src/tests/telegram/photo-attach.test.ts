// photo-attach.test.ts — attachInboundPhoto only writes the image onto a job
// that is STILL pending (G1). If the worker/cron already claimed the job, the
// out-of-txn photo attach must not clobber the in-flight transcript.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';

// The photo download + filesystem writes are external I/O — stub them so the
// test exercises only the conditional DB write.
vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getTelegramFile: vi.fn(async () => ({ bytes: Buffer.from('fake'), ext: 'jpg' })),
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
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
      jobId,
      entityId: seed.entityId,
      botToken: '123:fake',
      photo: { fileId: 'f1', chatId: '77', text: 'a photo' },
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
      jobId,
      entityId: seed.entityId,
      botToken: '123:fake',
      photo: { fileId: 'f1', chatId: '77', text: 'a photo' },
      db: db as unknown as RunnerDeps['db'],
    });

    const after = JSON.stringify(await messagesOf(jobId));
    expect(after).toBe(before); // untouched — no clobber of the in-flight transcript
    expect(after).not.toContain('"type":"image"');
  });
});
