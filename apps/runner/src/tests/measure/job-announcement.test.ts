// job-announcement.test.ts — le rejeu de l'annonce d'un job fini (#967), sur une
// base de test et un FAUX modèle (le réseau est simulé à la frontière du
// fournisseur ; la génération, la consigne et la clé passent par le vrai
// chemin du runner).
//
// Ce qui se prouve : chaque annonce est relevée sur ce qu'elle fait (lire le
// résultat, dire où le lire, proposer un canal, markdown, adresse web), la
// requête au modèle est celle du runner, et le rejeu n'écrit RIEN en base.
//
// Mutations vérifiées (chacune rougit un cas) :
//   - `observe: null` remplacé par un traceur → « writes nothing » (une ligne
//     llm_calls apparaît) ;
//   - `longestSharedPhrase` qui rend toujours null → « an announcement that
//     reads the result ».

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  channelBindings,
  entityLlmKeys,
  eq,
  llmCalls,
  telegramAllowedChats,
  sql,
} from '@nodal-agents/db';
import {
  longestSharedPhrase,
  measureJobAnnouncement,
  summarizeAnnouncements,
} from '../../measure/job-announcement.ts';

vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

let db: TestDb;
let jobId = '';
const RESULT =
  '**Microsoft layoffs: latest news (as of 4 Nov 2026)**\n\nThe main recent story is a voluntary ' +
  'buyout, not a layoff. About 60,000 employees are eligible. Source: https://www.nytimes.com/x';

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  ({ db } = await spinUpTestDb());
  const seed = await seedMinimal(db);
  const [key] = await db
    .insert(entityLlmKeys)
    .values({
      entityId: seed.entityId,
      provider: 'openrouter',
      apiKey: encrypt('or-test-key'),
      nickname: 'OpenRouter (test)',
      isActive: true,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Alfred',
      slug: 'alfred-replay',
      personality: 'You are Alfred.',
      role: 'orchestrator',
      llmKeyId: key!.id,
      model: 'anthropic/claude-haiku-5.5',
    })
    .returning();
  await db.insert(channelBindings).values({
    entityId: seed.entityId,
    agentId: agent!.id,
    channel: 'telegram',
    credentials: JSON.stringify({ botToken: 'fake' }),
    enabled: true,
  });
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: agent!.id,
    chatId: 'owner',
    role: 'owner',
    status: 'active',
  });
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: agent!.id,
      channel: 'dashboard',
      task: 'Search the web for the latest news about Microsoft layoffs.',
      status: 'completed',
      result: RESULT,
      replyRendering: 'spoken',
      messages: [],
      chainCount: 0,
    })
    .returning({ id: agentJobs.id });
  jobId = job!.id;
});

afterEach(() => vi.unstubAllGlobals());

/** The fake model: one answer per call, in order; each request kept as received. */
function fakeModel(answers: string[]): Array<{ model: string; system: string; user: string }> {
  const seen: Array<{ model: string; system: string; user: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/chat/completions')) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(init?.body as string) as {
        model: string;
        messages: Array<{ role: string; content: unknown }>;
      };
      const text = (c: unknown): string =>
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.map((p) => String((p as { text?: unknown }).text ?? '')).join('')
            : '';
      seen.push({
        model: body.model,
        system: text(body.messages.find((m) => m.role === 'system')?.content),
        user: text(body.messages.at(-1)?.content),
      });
      const content = answers[seen.length - 1] ?? '';
      return Response.json({
        id: 'c',
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }),
  );
  return seen;
}

describe('the announcement replay of #967 @cap:parler-a-un-agent/moteur', () => {
  it('records what each announcement does, through the runner’s own generation, and writes nothing', async () => {
    const before = await db.select({ n: sql<number>`count(*)` }).from(llmCalls);
    const seen = fakeModel([
      'The research is ready. You can read it in Nodal, or I can send it to you on Telegram.',
      'The main recent story is a voluntary buyout, not a layoff. About 60,000 are eligible.',
      '**Done.** See https://www.nytimes.com/x',
    ]);

    const measure = await measureJobAnnouncement(db as never, { jobId, runs: 3 });

    expect(measure.job).toMatchObject({
      id: jobId,
      resultChars: RESULT.length,
      channels: ['telegram'],
    });
    expect(seen).toHaveLength(3);
    expect(seen[0]!.model).toBe('anthropic/claude-haiku-5.5');
    expect(seen[0]!.system).toContain('You are Alfred.');
    expect(seen[0]!.user).toContain('offer to send it to them on telegram');
    expect(seen[0]!.user).toContain(RESULT);

    const [announces, reads, marked] = measure.records;
    expect(announces).toMatchObject({
      words: 19,
      sentences: 2,
      sharedPhrase: null,
      numbersFromResult: [],
      saysWhere: true,
      offersChannels: ['telegram'],
      markdown: false,
      url: false,
    });
    expect(reads).toMatchObject({
      sharedPhrase: 'the main recent story is a voluntary buyout not a layoff about 60 000',
      numbersFromResult: ['60000'],
      saysWhere: false,
      offersChannels: [],
    });
    // The URL read out is the result's own: it counts as reading it.
    expect(marked).toMatchObject({
      markdown: true,
      url: true,
      sharedPhrase: 'https www nytimes com x',
    });
    expect(summarizeAnnouncements(measure.records)).toContain(
      'reads the result (a 5+ word phrase of it) 2/3',
    );

    // Nothing written: no traced call, no announcement stored on the row.
    const after = await db.select({ n: sql<number>`count(*)` }).from(llmCalls);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    const [row] = await db
      .select({ spoken: agentJobs.spokenAnnouncement, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row).toEqual({ spoken: null, result: RESULT });
  });

  it('a call the model refuses is recorded as a failure, with no key in it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { message: 'bad key or-test-key sk-or-v1-' + 'b'.repeat(64) } },
          { status: 401 },
        ),
      ),
    );
    const measure = await measureJobAnnouncement(db as never, { jobId, runs: 1 });
    expect(measure.records[0]).toMatchObject({ text: null, code: 'announcement_failed' });
    expect(measure.records[0]!.detail ?? '').not.toContain('sk-or-v1-' + 'b'.repeat(64));
  });

  it('a shared phrase is five words at least, read on words, not on punctuation', () => {
    expect(longestSharedPhrase('It is ready now.', 'It is ready now, really.')).toBeNull();
    expect(
      longestSharedPhrase(
        'About 60,000 employees are eligible!',
        'about 60 000 employees are eligible',
      ),
    ).toBe('about 60 000 employees are eligible');
  });
});
