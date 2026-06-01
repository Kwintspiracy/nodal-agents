// thread-history.test.ts — loadThreadHistory returns the right ModelMessages
// for prior turns in the same (channel, chat_id) thread.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs } from '@nodal-agents/db';
import type { ModelMessage } from 'ai';
import { loadThreadHistory } from '../../job/thread-history.ts';

/**
 * Reduce a ModelMessage[] to a flat `(role, text)` list — surfacing the
 * user-visible text whether it lives in `content` as a string, in a
 * `text` part, or as the `input.text` of a `tool-call` part. Synthetic
 * tool-result messages contribute nothing. Lets tests assert intent
 * (who said what) regardless of whether the helper chose the 2-message
 * text shape or the 3-message tool-call shape.
 */
function summarize(messages: ModelMessage[]): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') {
      out.push({ role: m.role, text: c });
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (!p || typeof p !== 'object') continue;
      const part = p as { type?: unknown; text?: unknown; input?: unknown };
      if (part.type === 'text' && typeof part.text === 'string') {
        out.push({ role: m.role, text: part.text });
      } else if (part.type === 'tool-call' && part.input && typeof part.input === 'object') {
        const text = (part.input as { text?: unknown }).text;
        if (typeof text === 'string') out.push({ role: m.role, text });
      }
      // tool-result parts: synthetic ack, ignored.
    }
  }
  return out;
}

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  // Each test starts with a clean agent_jobs table — earlier inserts must
  // not leak into the next test's history query.
  await db.delete(agentJobs);
});

// Helpers ──────────────────────────────────────────────────────────────────────

/** Insert a completed Telegram job in the named chat with given task/result + creation offset (minutes ago). */
async function insertCompletedJob(opts: {
  chatId: string;
  task: string;
  result: string | null;
  minutesAgo?: number;
  status?: 'completed' | 'failed';
  /** Optional `messages` JSONB — defaults to `[]`. Used to exercise the
   * fallback chain in `extractAssistantReply` (tool-call extraction). */
  messages?: unknown;
  /** Channel to insert on — defaults to 'telegram'. */
  channel?: string;
}): Promise<string> {
  const createdAt = opts.minutesAgo ? new Date(Date.now() - opts.minutesAgo * 60_000) : new Date();
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: opts.channel ?? 'telegram',
      task: opts.task,
      chatId: opts.chatId,
      status: opts.status ?? 'completed',
      result: opts.result,
      messages: (opts.messages ?? []) as never,
      createdAt,
    })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('insert returned no row');
  return row.id;
}

/** Build a minimal `messages` array matching what a Conciergus-style Telegram
 *  reply looks like at runtime: a user task, then an assistant tool-call to
 *  `telegram_send_message` carrying the user-visible `text`. */
function tgReply(userTask: string, ...sends: string[]): unknown[] {
  return [
    { role: 'user', content: userTask },
    {
      role: 'assistant',
      content: sends.map((text) => ({
        type: 'tool-call',
        toolName: 'telegram_send_message',
        input: { text },
      })),
    },
  ];
}

// Tests ───────────────────────────────────────────────────────────────────────

describe('loadThreadHistory', () => {
  it('returns [] when there are no prior jobs in the thread', async () => {
    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });
    expect(history).toEqual([]);
  });

  it('returns [] for non-conversational channels (api, cron, etc.)', async () => {
    // Even if matching rows exist, an `api` channel must never get history.
    await insertCompletedJob({ chatId: '12345', task: 'old', result: 'reply' });
    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });
    expect(history).toEqual([]);
  });

  it('returns 6 ModelMessages in chronological order for 3 prior completed jobs', async () => {
    await insertCompletedJob({
      chatId: '12345',
      task: 'first',
      result: 'first reply',
      minutesAgo: 30,
    });
    await insertCompletedJob({
      chatId: '12345',
      task: 'second',
      result: 'second reply',
      minutesAgo: 20,
    });
    await insertCompletedJob({
      chatId: '12345',
      task: 'third',
      result: 'third reply',
      minutesAgo: 10,
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    expect(summarize(history)).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'first reply' },
      { role: 'user', text: 'second' },
      { role: 'assistant', text: 'second reply' },
      { role: 'user', text: 'third' },
      { role: 'assistant', text: 'third reply' },
    ]);
  });

  it('skips jobs with null result (hard fails — runner crash, LLM down)', async () => {
    await insertCompletedJob({
      chatId: '12345',
      task: 'asked something',
      result: 'got an answer',
      minutesAgo: 30,
    });
    await insertCompletedJob({
      chatId: '12345',
      task: 'asked again',
      result: null,
      status: 'failed',
      minutesAgo: 20,
    });
    await insertCompletedJob({
      chatId: '12345',
      task: 'asked a third time',
      result: 'third answer',
      minutesAgo: 10,
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    // The failed job is filtered out by the status='completed' clause AND
    // would also be skipped by the null-result guard. The remaining 2
    // completed jobs produce 4 user/assistant entries in the summarised view.
    const s = summarize(history);
    expect(s).toHaveLength(4);
    expect(s[0]?.text).toBe('asked something');
    expect(s[2]?.text).toBe('asked a third time');
  });

  it('excludes the current job from history', async () => {
    const otherId = await insertCompletedJob({
      chatId: '12345',
      task: 'prior',
      result: 'prior reply',
      minutesAgo: 10,
    });
    const currentId = await insertCompletedJob({
      chatId: '12345',
      task: 'current',
      result: 'current reply',
      minutesAgo: 0,
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: currentId,
    });

    // Only the `otherId` job should appear — never the current one.
    expect(summarize(history)).toEqual([
      { role: 'user', text: 'prior' },
      { role: 'assistant', text: 'prior reply' },
    ]);
    void otherId;
  });

  it('drops jobs older than the 24h idle reset window', async () => {
    await insertCompletedJob({
      chatId: '12345',
      task: 'too old',
      result: 'too old reply',
      minutesAgo: 60 * 25, // 25 hours ago — past the 1440-min window
    });
    await insertCompletedJob({
      chatId: '12345',
      task: 'fresh',
      result: 'fresh reply',
      minutesAgo: 5,
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    expect(summarize(history)).toEqual([
      { role: 'user', text: 'fresh' },
      { role: 'assistant', text: 'fresh reply' },
    ]);
  });

  it('truncates any single message above the per-turn cap', async () => {
    const huge = 'x'.repeat(10_000);
    await insertCompletedJob({
      chatId: '12345',
      task: 'short prompt',
      result: huge,
      minutesAgo: 5,
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    const s = summarize(history);
    expect(s).toHaveLength(2);
    const aText = s[1]?.text ?? '';
    // Per-turn cap is 2000 chars; truncation adds a short marker.
    expect(aText.length).toBeLessThanOrEqual(2_100);
    expect(aText).toContain('truncated');
  });

  it('drops oldest pairs when the total char budget is exceeded — never an assistant orphan', async () => {
    // Each turn below = 1500 chars (under the 2000 per-turn cap, no
    // truncation), so each pair = 3000 chars. With BUDGET_CHARS=4000
    // and 5 prior pairs (15 000 chars total), the helper must drop the
    // oldest pairs until ≤ 4000, which leaves exactly 1 pair (3000 chars).
    const big = 'y'.repeat(1_500);
    for (let i = 0; i < 5; i++) {
      await insertCompletedJob({
        chatId: '12345',
        task: big,
        result: big,
        minutesAgo: 60 - i * 5,
      });
    }

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    // Exactly one block must survive (3000 ≤ 4000 budget).
    const s = summarize(history);
    expect(s).toHaveLength(2);
    expect(s[0]?.role).toBe('user');
    expect(s[1]?.role).toBe('assistant');
  });

  it('extracts the assistant reply from telegram_send_message when result is null', async () => {
    // Mirrors what Conciergus produces at runtime: result column empty,
    // user-visible reply lives inside the telegram_send_message tool call.
    await insertCompletedJob({
      chatId: '12345',
      task: 'combien font 7 * 52',
      result: null,
      minutesAgo: 5,
      messages: tgReply('combien font 7 * 52', '7 × 52 = **364**'),
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    expect(summarize(history)).toEqual([
      { role: 'user', text: 'combien font 7 * 52' },
      { role: 'assistant', text: '7 × 52 = **364**' },
    ]);
  });

  it('concatenates multiple telegram_send_message tool calls with a double newline', async () => {
    await insertCompletedJob({
      chatId: '12345',
      task: 'résume la situation',
      result: null,
      minutesAgo: 5,
      messages: tgReply('résume la situation', 'Premier point.', 'Deuxième point.'),
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    const s = summarize(history);
    expect(s).toHaveLength(2);
    expect(s[1]?.text).toBe('Premier point.\n\nDeuxième point.');
  });

  it('falls back to the last assistant text content when no send-message tool call is present', async () => {
    // Edge case: agent replied with a bare assistant text turn (no tool call,
    // no return_result text). Rare but possible — the extractor must still
    // surface that text rather than swallow the turn.
    await insertCompletedJob({
      chatId: '12345',
      task: 'salut',
      result: null,
      minutesAgo: 5,
      messages: [
        { role: 'user', content: 'salut' },
        { role: 'assistant', content: 'salut Quentin !' },
      ],
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    expect(summarize(history)).toEqual([
      { role: 'user', text: 'salut' },
      { role: 'assistant', text: 'salut Quentin !' },
    ]);
  });

  it('prefers result over the messages fallback when result is non-empty', async () => {
    // Long-form return_result with text: the result column wins over any
    // telegram_send_message that might also appear in messages.
    await insertCompletedJob({
      chatId: '12345',
      task: 'rapport complet',
      result: 'Le rapport canonique vit dans result.',
      minutesAgo: 5,
      messages: tgReply('rapport complet', 'extrait court envoyé sur Telegram'),
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    const s = summarize(history);
    expect(s).toHaveLength(2);
    expect(s[1]?.text).toBe('Le rapport canonique vit dans result.');
  });

  it('isolates threads by chat_id — other chats do not leak in', async () => {
    await insertCompletedJob({
      chatId: 'chat-A',
      task: 'in A',
      result: 'A reply',
      minutesAgo: 10,
    });
    await insertCompletedJob({
      chatId: 'chat-B',
      task: 'in B',
      result: 'B reply',
      minutesAgo: 10,
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'chat-A',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    const s = summarize(history);
    expect(s).toHaveLength(2);
    expect(s[0]?.text).toBe('in A');
  });

  // Regression: Telegram channels must produce a 3-message tool-call block
  // (not a plain assistant text turn), so the LLM sees "reply via the
  // channel send tool" as the prior pattern and follows it. Without this
  // shape we observed live (job c25447d8, 2026-05-25) the agent imitating
  // plain text and never calling telegram_send_message.
  it('emits a 3-message tool-call block for telegram (user → assistant tool-call → tool-result)', async () => {
    await insertCompletedJob({
      chatId: '12345',
      task: 'combien font 7 * 52',
      result: null,
      minutesAgo: 5,
      messages: tgReply('combien font 7 * 52', '7 × 52 = **364**'),
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    // Raw shape — 3 messages: user TEXT, assistant tool-call, tool tool-result.
    expect(history).toHaveLength(3);
    expect(history[0]?.role).toBe('user');
    expect(history[1]?.role).toBe('assistant');
    expect(history[2]?.role).toBe('tool');

    const assistantContent = history[1]?.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    const toolCallPart = (assistantContent as unknown[])[0] as Record<string, unknown>;
    expect(toolCallPart['type']).toBe('tool-call');
    expect(toolCallPart['toolName']).toBe('telegram_send_message');
    expect((toolCallPart['input'] as { text?: string }).text).toBe('7 × 52 = **364**');

    const toolContent = history[2]?.content;
    expect(Array.isArray(toolContent)).toBe(true);
    const resultPart = (toolContent as unknown[])[0] as Record<string, unknown>;
    expect(resultPart['type']).toBe('tool-result');
    // Same toolCallId binds the tool-call to its result (validateMessageStructure requirement).
    expect(resultPart['toolCallId']).toBe(toolCallPart['toolCallId']);
  });

  // Regression: session-memory CHAINING — a prior job's `messages` JSONB
  // contains BOTH the history that was injected into it when it ran AND
  // its own actual turns. Without slicing from the task boundary, the
  // extractor concatenates older telegram_send_message tool-calls from
  // the injected history with the actual reply and truncates at 2000 chars,
  // surfacing stale text from much older jobs. Observed live on job
  // 9c22d5b3 (2026-05-26) where 3 Stripe-related prior jobs all returned
  // the same stale Cortex pre-amble.
  it('ignores tool-calls from injected history when extracting a prior job reply', async () => {
    // Simulate a prior job whose `messages` array starts with an OLD
    // 3-msg block (the session-memory injection from earlier turns) and
    // ends with the job's OWN user+assistant turn. The extractor must
    // surface ONLY the own-turn reply, not concatenate the stale one.
    const polluted: unknown[] = [
      // ── Injected history from older jobs (NOT this job's content) ──
      { role: 'user', content: 'combien font 4 * 5' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'history-tool-0',
            toolName: 'telegram_send_message',
            input: { text: '4 × 5 = 20. Aussi, le Cortex bouillonne aujourd hui…' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'history-tool-0',
            toolName: 'telegram_send_message',
            output: { type: 'json', value: { messageId: 'history' } },
          },
        ],
      },
      // ── This job's actual turn ──
      { role: 'user', content: 'donne-moi le solde de mon compte Stripe' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'real-call-0',
            toolName: 'telegram_send_message',
            input: { text: 'Solde Stripe : 0,00 € (compte test).' },
          },
        ],
      },
    ];
    await insertCompletedJob({
      chatId: '12345',
      task: 'donne-moi le solde de mon compte Stripe',
      result: null,
      minutesAgo: 5,
      messages: polluted,
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    const s = summarize(history);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({
      role: 'user',
      text: 'donne-moi le solde de mon compte Stripe',
    });
    expect(s[1]).toEqual({
      role: 'assistant',
      text: 'Solde Stripe : 0,00 € (compte test).',
    });
    // Most importantly: the stale Cortex/calc text MUST NOT bleed through.
    expect(s[1]?.text).not.toContain('4 × 5');
    expect(s[1]?.text).not.toContain('Cortex');
  });
});
