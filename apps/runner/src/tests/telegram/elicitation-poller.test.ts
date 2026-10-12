// elicitation-poller.test.ts — la question d'un serveur MCP (0145) remplie
// DEPUIS TELEGRAM, à travers le vrai poller et le vrai adaptateur : seul
// `fetch` (l'API Bot) est simulé.
//
// Ce qui est relu : la ligne (brouillon, statut, réponse), les jobs (aucun ne
// naît d'un geste ni d'une réponse à la carte), l'offset, et les appels à
// l'API Bot (la carte réécrite AVEC ses boutons, les bulles des boutons).

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agents,
  agentJobs,
  approvalRequests,
  approvalCardMessages,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { elicitationCallbackData, elicitationDraftRevision } from '@nodal-agents/shared';
import { runTelegramPoller } from '../../telegram/poller.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

const FAKE_TOKEN = '111:tok';
const CARD_MESSAGE = 900;
const env = { WORKER_SECRET: 's', APP_URL: 'http://localhost:3099' } as unknown as RunnerEnv;

const FORM = {
  type: 'object',
  properties: {
    copies: { type: 'integer', title: 'Copies', minimum: 1, maximum: 5 },
    duplex: { type: 'boolean', title: 'Two-sided' },
  },
  required: ['copies'],
};

function makeDeps(db: TestDb): RunnerDeps {
  return { db: db as unknown as RunnerDeps['db'] } as RunnerDeps;
}

function tap(updateId: number, data: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      data,
      from: { id: 7, first_name: 'A' },
      message: { message_id: CARD_MESSAGE, chat: { id: 555, type: 'private' } },
    },
  };
}

function reply(updateId: number, text: string, replyTo = CARD_MESSAGE): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 555, type: 'private' },
      from: { id: 7, first_name: 'A', is_bot: false },
      text,
      reply_to_message: { message_id: replyTo, from: { is_bot: true, username: 'test_bot' } },
    },
  };
}

describe('la question d’un serveur MCP remplie depuis Telegram @cap:approuver-une-action/moteur', () => {
  let db: TestDb;
  let seed: { entityId: string; agentId: string; jobId: string };
  let fetchSpy: MockInstance<typeof globalThis.fetch>;

  beforeEach(async () => {
    db = (await spinUpTestDb()).db;
    seed = await seedMinimal(db);
    await db
      .update(agents)
      .set({ telegramBotToken: FAKE_TOKEN })
      .where(eq(agents.id, seed.agentId));
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '555',
      role: 'owner',
      status: 'active',
    });
    await db
      .update(agentJobs)
      .set({ channel: 'telegram', chatId: '555', status: 'processing' })
      .where(eq(agentJobs.id, seed.jobId));
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(updates: unknown[]) {
    const controller = new AbortController();
    let polls = 0;
    const botApi: Array<{ method: string; body: Record<string, unknown> }> = [];
    fetchSpy.mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/api/worker')) return Promise.resolve(new Response('ok'));
      const method = url.slice(url.lastIndexOf('/') + 1);
      if (method !== 'getUpdates') {
        botApi.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
        );
      }
      polls += 1;
      if (polls === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 }),
        );
      }
      controller.abort();
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
      );
    });
    const exit = await runTelegramPoller({
      agentId: seed.agentId,
      agentEntityId: seed.entityId,
      botToken: FAKE_TOKEN,
      botUsername: 'test_bot',
      startOffset: 0,
      signal: controller.signal,
      deps: makeDeps(db),
      env,
      longPollSeconds: 1,
    });
    return { exit, botApi };
  }

  async function question(): Promise<string> {
    const [row] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'printer__request_print',
        toolInput: { server: 'printer', message: 'Print it?', requestedSchema: FORM },
        kind: 'elicitation',
        status: 'pending',
        executedAt: new Date(),
      })
      .returning();
    await db.insert(approvalCardMessages).values({
      approvalRequestId: row!.id,
      channel: 'telegram',
      agentId: seed.agentId,
      conversationId: '555',
      messageId: String(CARD_MESSAGE),
    });
    return row!.id;
  }

  it('un appui, ✏️, une réponse tapée, Send : la demande est tranchée et aucun job ne naît', async () => {
    const id = await question();
    const { exit, botApi } = await run([
      tap(10, elicitationCallbackData(id, { op: 'bool', field: 1, value: true })),
      tap(11, elicitationCallbackData(id, { op: 'type', field: 0 })),
      reply(12, '3'),
      tap(
        13,
        elicitationCallbackData(id, {
          op: 'send',
          revision: elicitationDraftRevision({ duplex: true, copies: 3 }),
        }),
      ),
    ]);

    expect(exit.finalOffset).toBe(14);
    const jobs = await db.select({ id: agentJobs.id }).from(agentJobs);
    expect(jobs).toEqual([{ id: seed.jobId }]);

    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(row!.status).toBe('approved');
    expect(row!.resolvedBy).toBe('telegram');
    expect(row!.response).toEqual({ copies: 3, duplex: true });

    // La carte a été réécrite AVEC ses boutons après chaque geste, puis réglée.
    const edits = botApi.filter((c) => c.method === 'editMessageText');
    expect(edits[0]!.body['message_id']).toBe(CARD_MESSAGE);
    expect(JSON.stringify(edits[0]!.body['reply_markup'])).toContain('✓ Two-sided: Yes');
    expect(String(edits[1]!.body['text'])).toContain('Reply to this message with Copies');
    expect(String(edits[2]!.body['text'])).toContain('Copies: 3');
    expect(edits.at(-1)!.body['text']).toBe('✅ Answered');
    const bubbles = botApi
      .filter((c) => c.method === 'answerCallbackQuery')
      .map((c) => c.body['text'] ?? null);
    expect(bubbles).toEqual([null, 'Reply to the card with Copies.', 'Answered.']);
  });

  it('une réponse à un AUTRE message reste un message : un tour de conversation', async () => {
    await question();
    await run([reply(20, 'what about tomorrow?', 4242)]);
    const jobs = await db.select({ task: agentJobs.task }).from(agentJobs);
    expect(jobs.map((j) => j.task)).toContain('what about tomorrow?');
  });

  it('une valeur refusée est dite dans la conversation, et rien n’est pris', async () => {
    const id = await question();
    const { botApi } = await run([
      tap(30, elicitationCallbackData(id, { op: 'type', field: 0 })),
      reply(31, '12'),
    ]);
    const said = botApi.filter((c) => c.method === 'sendMessage').map((c) => c.body['text']);
    expect(said).toEqual(['Not taken: Copies must be at most 5.']);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(row!.draft).toEqual({ values: {}, awaiting: 'copies' });
    expect((await db.select().from(agentJobs)).length).toBe(1);
  });
});
