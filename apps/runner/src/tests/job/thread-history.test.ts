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
  /** When the reply was DELIVERED (completed_at), minutes ago. Defaults to unset
   *  (→ the gap logic falls back to created_at). Set it to simulate a SLOW job
   *  whose reply reached the user long after the message arrived. */
  completedMinutesAgo?: number;
  status?: 'completed' | 'failed';
  /** Optional `messages` JSONB — defaults to `[]`. Used to exercise the
   * fallback chain in `extractAssistantReply` (tool-call extraction). */
  messages?: unknown;
  /** Channel to insert on — defaults to 'telegram'. */
  channel?: string;
  /** Optional `tools_used` — drives the Layer-1 action ledger. Defaults to unset. */
  toolsUsed?: string[];
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
      ...(opts.toolsUsed !== undefined ? { toolsUsed: opts.toolsUsed } : {}),
      ...(opts.completedMinutesAgo !== undefined
        ? { completedAt: new Date(Date.now() - opts.completedMinutesAgo * 60_000) }
        : {}),
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

  it('includes a FAILED job that delivered a user-facing reply (ask-and-wait continuity)', async () => {
    // Regression: the agent asked the user to launch ComfyUI; that job ended
    // `failed` (the generation couldn't finish) but DELIVERED the reply the user
    // saw and replied to ("Il est lancé"). It MUST be in the next turn's history,
    // or the agent has amnesia about what it just asked.
    await insertCompletedJob({
      chatId: '777',
      task: 'mix the photo with my redhead and generate',
      result: 'Workflow ready. ComfyUI is not running — launch it and tell me when it is.',
      status: 'failed',
      minutesAgo: 3,
    });
    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '777',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });
    const flat = summarize(history);
    expect(flat.some((m) => m.role === 'user' && m.text.includes('redhead'))).toBe(true);
    expect(flat.some((m) => m.role === 'assistant' && /launch it and tell me/i.test(m.text))).toBe(
      true,
    );
  });

  it('still skips a FAILED job with no user-facing result (silent internal failure)', async () => {
    await insertCompletedJob({
      chatId: '888',
      task: 'internal thing',
      result: null,
      status: 'failed',
      minutesAgo: 2,
      messages: [],
    });
    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '888',
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

  it('drops jobs beyond the 24h outer scan bound', async () => {
    await insertCompletedJob({
      chatId: '12345',
      task: 'too old',
      result: 'too old reply',
      minutesAgo: 60 * 25, // 25 hours ago — past the 24h MAX_LOOKBACK scan bound
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

  it('resets the session after an idle gap — a 12h-old turn is dropped though within the 24h scan', async () => {
    // The exact live bug: an unrelated image-gen turn 12h ago bled into a fresh
    // research request because the old loader used a rolling 24h window. With a
    // gap-based reset, the 12h silence (>> 30 min) starts a clean conversation.
    await insertCompletedJob({
      chatId: '12345',
      task: 'image gen prompt',
      result: 'image generated',
      minutesAgo: 60 * 12, // 12h ago — inside the 24h scan, but past the idle gap
    });
    await insertCompletedJob({
      chatId: '12345',
      task: 'research string theory',
      result: 'research reply',
      minutesAgo: 3,
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    // Only the recent turn survives — the 12h-old exchange is NOT context.
    expect(summarize(history)).toEqual([
      { role: 'user', text: 'research string theory' },
      { role: 'assistant', text: 'research reply' },
    ]);
  });

  it('breaks the session at an internal idle gap — keeps only the contiguous recent run', async () => {
    // old topic, then a silence past the idle-reset (now 4h), then two recent
    // turns a few min apart. The old topic is dropped; the recent run is kept.
    await insertCompletedJob({
      chatId: '12345',
      task: 'old topic',
      result: 'old reply',
      minutesAgo: 60 * 5, // 5h ago — past the 4h idle-reset gap
    });
    await insertCompletedJob({
      chatId: '12345',
      task: 'new A',
      result: 'reply A',
      minutesAgo: 8,
    });
    await insertCompletedJob({
      chatId: '12345',
      task: 'new B',
      result: 'reply B',
      minutesAgo: 3,
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    // Gap between 'new A' (8 min) and 'old topic' (50 min) = 42 min ≥ 30 → cut.
    expect(summarize(history)).toEqual([
      { role: 'user', text: 'new A' },
      { role: 'assistant', text: 'reply A' },
      { role: 'user', text: 'new B' },
      { role: 'assistant', text: 'reply B' },
    ]);
  });

  it('returns [] when even the most recent prior turn is past the idle gap', async () => {
    // Nothing newer than 5h ago → the whole prior session is stale (idle-reset = 4h).
    await insertCompletedJob({
      chatId: '12345',
      task: 'stale turn',
      result: 'stale reply',
      minutesAgo: 60 * 5,
    });

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

  it('truncates a long message keeping BOTH head and tail (the conclusion survives)', async () => {
    // A long reply whose load-bearing conclusion is at the END. Head+tail
    // truncation must keep both the opening AND the closing instruction.
    const huge = 'HEAD_OPENING ' + 'x'.repeat(10_000) + ' TAIL_CONCLUSION';
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
    // Per-turn cap is 2400 chars + a short marker.
    expect(aText.length).toBeLessThanOrEqual(2_500);
    expect(aText).toContain('truncated');
    // BOTH ends are preserved — not just the head.
    expect(aText).toContain('HEAD_OPENING');
    expect(aText).toContain('TAIL_CONCLUSION');
  });

  it('drops oldest pairs when the total char budget is exceeded — never an assistant orphan', async () => {
    // Each turn = 2400 chars (at the per-turn cap, no truncation), so each block
    // counts ≈ 4800 chars in the budget. With BUDGET_CHARS=16000 and 8 prior
    // blocks (≈38 400 total), the helper drops oldest blocks until ≤ 16000 →
    // 3 blocks survive (≈14 400). All 8 are one active session (5-min gaps,
    // newest 5 min ago) so the gap reset keeps them and the budget trim is what
    // is exercised.
    const big = 'y'.repeat(2_400);
    for (let i = 0; i < 8; i++) {
      await insertCompletedJob({
        chatId: '12345',
        task: big,
        result: big,
        minutesAgo: 40 - i * 5,
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

    // 3 blocks survive (3×4800 = 14400 ≤ 16000; a 4th would be 19200 > 16000).
    // Survivors are the MOST RECENT, in complete (user, assistant) pairs.
    const s = summarize(history);
    expect(s).toHaveLength(6);
    expect(s[0]?.role).toBe('user');
    expect(s[5]?.role).toBe('assistant');
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

  it('measures the idle gap from DELIVERY (completed_at), not job start — a slow job keeps a quick follow-up', async () => {
    // The live ComfyUI bug (jobs dbbf4d8c → 8b493110). The agent's job was CREATED
    // 5h ago (when the user sent the photo) but its reply was DELIVERED only 10 min
    // ago (a slow 4h50m analysis/prep). The user replied right after. A
    // created_at→created_at gap reads 5h and WIPES the thread; the correct
    // delivery-based gap is 10 min, so the thread is kept and the agent remembers
    // exactly what it asked ("launch ComfyUI and tell me").
    await insertCompletedJob({
      chatId: '12345',
      task: 'analyze the photo and prep the workflow',
      result: 'Workflow ready. Launch ComfyUI and tell me when it is.',
      minutesAgo: 60 * 5, // created 5h ago — past the 4h idle-reset if measured from creation
      completedMinutesAgo: 10, // but DELIVERED only 10 min ago
    });

    const history = await loadThreadHistory({
      db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '12345',
      excludeJobId: '00000000-0000-0000-0000-000000000000',
    });

    const flat = summarize(history);
    expect(flat.some((m) => /launch comfyui/i.test(m.text))).toBe(true);
  });

  // ─── Action ledger (Layer 1, 2026-07-11 incident) ──────────────────────────

  it('appends an action ledger line when the prior job used a state-changing tool', async () => {
    await insertCompletedJob({
      chatId: '12345',
      task: 'peux-tu poster une annonce Discord à chaque release ?',
      result: null,
      minutesAgo: 5,
      messages: tgReply(
        'peux-tu poster une annonce Discord à chaque release ?',
        'Fait, une automation est en place.',
      ),
      toolsUsed: ['create_schedule', 'telegram_send_message'],
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
    expect(s).toContainEqual({
      role: 'assistant',
      text: '[Actions performed in this exchange: create_schedule, telegram_send_message]',
    });
  });

  it('does NOT append a ledger line when the prior job only used send tools', async () => {
    await insertCompletedJob({
      chatId: '12345',
      task: 'dis bonjour',
      result: null,
      minutesAgo: 5,
      messages: tgReply('dis bonjour', 'Bonjour !'),
      toolsUsed: ['telegram_send_message'],
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
    expect(s.some((m) => m.text.includes('Actions performed'))).toBe(false);
  });

  it('does NOT append a ledger line when tools_used is null/empty', async () => {
    await insertCompletedJob({
      chatId: '12345',
      task: 'dis bonjour',
      result: 'Bonjour !',
      minutesAgo: 5,
      // toolsUsed omitted — column defaults to '{}'.
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
    expect(s.some((m) => m.text.includes('Actions performed'))).toBe(false);
  });
});
