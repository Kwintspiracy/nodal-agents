// job-announcement.test.ts — le rejeu de l'annonce de jobs finis (#967), sur une
// base de test et un FAUX modèle (le réseau est simulé à la frontière du
// fournisseur ; la génération, la consigne et la clé passent par le vrai
// chemin du runner).
//
// Ce qui se prouve : chaque annonce est relevée sur ce qu'elle fait (lire le
// résultat, nommer un canal, dire où le lire, markdown, adresse web), les
// phrases identiques d'un essai à l'autre ET d'un job à l'autre sont
// comptées (une annonce qui sonne comme une formule), la requête au modèle est
// celle du runner, et le rejeu n'écrit RIEN en base.
//
// Mutations vérifiées (chacune rougit un cas) :
//   - `observe: null` remplacé par un traceur → « writes nothing » ;
//   - `longestSharedPhrase` qui rend toujours null → « records » et « phrase » ;
//   - `sameness` qui ne compte que dans un job → « records » (le croisement).

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agents, entityLlmKeys, eq, llmCalls, sql } from '@nodal-agents/db';
import {
  longestSharedPhrase,
  measureJobAnnouncements,
  summarizeAnnouncements,
  summarizeSameness,
} from '../../measure/job-announcement.ts';

vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

let db: TestDb;
let researchJob = '';
let printJob = '';
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
  const job = async (task: string, result: string) =>
    (
      await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: agent!.id,
          channel: 'dashboard',
          task,
          status: 'completed',
          result,
          replyRendering: 'spoken',
          messages: [],
          chainCount: 0,
        })
        .returning({ id: agentJobs.id })
    )[0]!.id;
  researchJob = await job('Search the web for the latest news about Microsoft layoffs.', RESULT);
  printJob = await job('Print it on one page.', 'Printing; not confirmed out yet.');
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
  it('records what each announcement does, counts the sentences that repeat, and writes nothing', async () => {
    const before = await db.select({ n: sql<number>`count(*)` }).from(llmCalls);
    const seen = fakeModel([
      // research, run 1 and 2
      'All done. You can read it in Nodal, or I can send it on Telegram.',
      'The main recent story is a voluntary buyout, not a layoff. About 60,000 are eligible.',
      // print, run 1 and 2
      'All done. The page is printing, not out yet.',
      '**Done.** See https://www.nytimes.com/x',
    ]);

    const measure = await measureJobAnnouncements(db as never, {
      jobIds: [researchJob, printJob],
      runs: 2,
    });

    expect(measure.jobs.map((j) => j.id)).toEqual([researchJob, printJob]);
    expect(seen).toHaveLength(4);
    expect(seen[0]!.model).toBe('anthropic/claude-haiku-5.5');
    expect(seen[0]!.system).toContain('You are Alfred.');
    expect(seen[0]!.user).toContain(RESULT);
    expect(seen[0]!.user).toContain('never offer to send it anywhere');

    const [scripted, reads, printed, marked] = measure.records;
    expect(scripted).toMatchObject({
      jobId: researchJob,
      run: 1,
      words: 15,
      sentences: 2,
      sharedPhrase: null,
      channelNames: ['telegram'],
      whereToRead: ['read it', 'nodal'],
      markdown: false,
      url: false,
    });
    expect(reads).toMatchObject({
      sharedPhrase: 'the main recent story is a voluntary buyout not a layoff about 60 000',
      numbersFromResult: ['60000'],
      channelNames: [],
      whereToRead: [],
    });
    expect(printed).toMatchObject({ jobId: printJob, channelNames: [], whereToRead: [] });
    expect(marked).toMatchObject({ markdown: true, url: true });

    // "All done." is said by both jobs: a formula, across jobs.
    expect(measure.sameness.acrossJobs).toEqual([
      { sentence: 'All done.', jobs: [researchJob, printJob] },
    ]);
    expect(measure.sameness.withinJobs).toEqual([]);
    expect(summarizeSameness(measure.sameness)).toContain('sentences repeated across jobs: 1');
    expect(summarizeAnnouncements(measure.records.slice(0, 2))).toContain('names a channel 1/2');

    // Nothing written: no traced call, no announcement stored on the rows.
    const after = await db.select({ n: sql<number>`count(*)` }).from(llmCalls);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    const rows = await db
      .select({ spoken: agentJobs.spokenAnnouncement })
      .from(agentJobs)
      .where(eq(agentJobs.id, researchJob));
    expect(rows).toEqual([{ spoken: null }]);
  });

  it('the same sentence in two runs of one job is counted within that job', async () => {
    fakeModel(['It is done.', 'It is done. Nice one.']);
    const measure = await measureJobAnnouncements(db as never, { jobIds: [printJob], runs: 2 });
    expect(measure.sameness.withinJobs).toEqual([
      { jobId: printJob, sentence: 'It is done.', runs: 2 },
    ]);
    expect(measure.sameness.acrossJobs).toEqual([]);
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
    const measure = await measureJobAnnouncements(db as never, { jobIds: [researchJob], runs: 1 });
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
