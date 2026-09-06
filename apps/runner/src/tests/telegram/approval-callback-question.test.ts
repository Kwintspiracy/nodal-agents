// approval-callback-question.test.ts — répondre à une QUESTION depuis un
// bouton Telegram (P10a).
//
// Ce qui est prouvé : le tap d'une option écrit la BONNE option sur la ligne
// (relue en base), un index hors liste ne touche à rien, un ✅ sur une question
// est refusé, et les gardes de sécurité des approbations valent aussi ici — un
// tap venu d'un autre chat que celui du propriétaire ne résout rien.
//
// Le parseur, lui, ne borne pas l'index : c'est la LIGNE qui borne. Ce fichier
// épingle les deux moitiés de cette division du travail.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { approvalRequests, agentJobs, agents, telegramAllowedChats } from '@nodal-agents/db';
import type { TelegramUpdate } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import {
  handleApprovalCallback,
  parseApprovalCallbackData,
} from '../../telegram/approval-callback.ts';

/** Toutes les requêtes sortantes du handler, capturées pour lire l'édition de carte. */
const calls: Array<{ url: string; body: unknown }> = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }),
);

const CHAT_ID = '199791464';
const OTHER_CHAT_ID = '777000222';
const OPTIONS = ['The repo README', 'A new file in notes'];

const env = {
  WORKER_SECRET: 'test-secret',
  APP_URL: 'http://localhost:3099',
} as unknown as RunnerEnv;

let db: TestDb;
let deps: RunnerDeps;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  await db
    .update(agentJobs)
    .set({ status: 'awaiting_approval', chatId: CHAT_ID })
    .where(eq(agentJobs.id, seed.jobId));
  await db.update(agents).set({ telegramBotToken: '123:fake' }).where(eq(agents.id, seed.agentId));
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId: CHAT_ID,
    role: 'owner',
    status: 'active',
  });
  deps = { db: db as RunnerDeps['db'] } as RunnerDeps;
});

async function insertQuestion(): Promise<string> {
  await db
    .update(agentJobs)
    .set({ status: 'awaiting_approval' })
    .where(eq(agentJobs.id, seed.jobId));
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'ask_user',
      toolInput: { question: 'Where should I write it?', options: OPTIONS },
      toolCallId: 'call-q',
      kind: 'question',
      status: 'pending',
    })
    .returning();
  return row!.id;
}

async function insertApproval(): Promise<string> {
  await db
    .update(agentJobs)
    .set({ status: 'awaiting_approval' })
    .where(eq(agentJobs.id, seed.jobId));
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'run_command',
      toolInput: { command: 'ls' },
      status: 'pending',
    })
    .returning();
  return row!.id;
}

function callbackUpdate(data: string, chatId: string): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'cbq-1',
      data,
      from: { id: 42, first_name: 'Q' },
      message: { message_id: 555, chat: { id: Number(chatId), type: 'private' } },
    },
  };
}

async function readBack(id: string) {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  return row!;
}

function lastEditedText(): string | null {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const c = calls[i]!;
    if (c.url.includes('editMessageText')) return (c.body as { text?: string }).text ?? null;
  }
  return null;
}

describe('parseApprovalCallbackData — le suffixe des options', () => {
  const id = '00000000-0000-0000-0000-0000000000ab';

  it('lit `o<n>` et rend son index', () => {
    expect(parseApprovalCallbackData(`apr:${id}:o0`)).toEqual({
      approvalRequestId: id,
      decision: 'option',
      optionIndex: 0,
    });
    expect(parseApprovalCallbackData(`apr:${id}:o1`)).toEqual({
      approvalRequestId: id,
      decision: 'option',
      optionIndex: 1,
    });
  });

  it("ne BORNE pas l'index — c'est la ligne qui borne, pas le format du bouton", () => {
    expect(parseApprovalCallbackData(`apr:${id}:o12`)).toEqual({
      approvalRequestId: id,
      decision: 'option',
      optionIndex: 12,
    });
  });

  it('refuse un suffixe qui ressemble à une option sans en être une', () => {
    expect(parseApprovalCallbackData(`apr:${id}:o`)).toBeNull();
    expect(parseApprovalCallbackData(`apr:${id}:ox`)).toBeNull();
    expect(parseApprovalCallbackData(`apr:${id}:o-1`)).toBeNull();
  });

  it('laisse les suffixes existants intacts', () => {
    expect(parseApprovalCallbackData(`apr:${id}:a`)).toEqual({
      approvalRequestId: id,
      decision: 'approve',
    });
    expect(parseApprovalCallbackData(`apr:${id}:wc`)).toEqual({
      approvalRequestId: id,
      decision: 'always_confirm',
    });
  });
});

describe('handleApprovalCallback — une question', () => {
  it('le tap sur `o1` écrit la 2e option sur la ligne et réécrit la carte', async () => {
    const id = await insertQuestion();
    calls.length = 0;

    const result = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:o1`, CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env,
    });

    expect(result).toEqual({
      handled: true,
      decision: 'answer',
      jobId: seed.jobId,
      answer: OPTIONS[1],
    });

    const row = await readBack(id);
    expect(row.status).toBe('approved');
    expect(row.answer).toBe(OPTIONS[1]);
    expect(row.resolvedBy).toBe('telegram');
    expect(lastEditedText()).toBe(`✅ Answered: ${OPTIONS[1]}`);
  });

  it('un index hors liste est refusé, et la ligne reste intacte', async () => {
    const id = await insertQuestion();

    const result = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:o7`, CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env,
    });

    expect(result).toEqual({ handled: false, reason: 'unknown_option' });
    const row = await readBack(id);
    expect(row.status).toBe('pending');
    expect(row.answer).toBeNull();
  });

  it('un ✅ sur une question est refusé : approuver ne dit pas LAQUELLE', async () => {
    const id = await insertQuestion();

    const result = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:a`, CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env,
    });

    expect(result).toEqual({ handled: false, reason: 'question_needs_option' });
    expect((await readBack(id)).status).toBe('pending');
  });

  it('un ❌ sur une question DÉCLINE — ce recours-là reste ouvert', async () => {
    const id = await insertQuestion();

    const result = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:r`, CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env,
    });

    expect(result).toEqual({ handled: true, decision: 'reject', jobId: seed.jobId });
    const row = await readBack(id);
    expect(row.status).toBe('rejected');
    expect(row.answer).toBeNull();
  });

  it("un tap venu d'un autre chat que celui du propriétaire ne résout rien", async () => {
    const id = await insertQuestion();

    const result = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:o0`, OTHER_CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env,
    });

    expect(result).toEqual({ handled: false, reason: 'chat_mismatch' });
    const row = await readBack(id);
    expect(row.status).toBe('pending');
    expect(row.answer).toBeNull();
  });

  it('une option tapée sur une APPROBATION ordinaire est refusée', async () => {
    const id = await insertApproval();

    const result = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:o0`, CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env,
    });

    expect(result).toEqual({ handled: false, reason: 'not_a_question' });
    expect((await readBack(id)).status).toBe('pending');
  });
});
