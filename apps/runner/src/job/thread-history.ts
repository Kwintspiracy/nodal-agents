// thread-history.ts — load recent prior turns from the same chat thread.
//
// Solves the "agent forgets what it just said 30 seconds ago" bug on Telegram
// (and other conversational channels). Each Telegram message creates its own
// `agent_jobs` row with a fresh `messages` array — without this helper, the
// LLM only sees the current turn, never the prior exchanges.
//
// Algorithm (see ~/.claude/plans/compiled-nibbling-stroustrup.md):
// - Only conversational channels (telegram, slack, discord). Others are
//   one-shot invocations and get no prior history.
// - Query up to MAX_TURNS recent completed jobs from the same
//   (entity, agent, channel, chat_id), then keep only the CURRENT session:
//   walk newest->oldest and stop at the first silence >= IDLE_RESET_MINUTES.
//   This is a real gap-based session reset (NOT a rolling time window): a
//   continuously-active session is kept whole however long it runs, while a
//   thread the user returns to after a break starts fresh — a 12h-old
//   exchange is not context for a new request.
// - Emit one (user, assistant) pair per prior job, from (task, result).
//   Skip jobs without a result (hard fail / interrupted — the user saw
//   nothing on their side either, so showing the LLM a hole is just noise).
// - Per-turn cap: truncate any single message above PER_TURN_MAX_CHARS so a
//   gigantic prior reply can't blow the budget on its own.
// - Total budget: drop oldest pairs from the front until under BUDGET_CHARS.
//   Always drop a full pair — never an assistant orphan that would leave
//   the LLM staring at "[assistant] response with no preceding user msg".
// - Return chronological (oldest first) so the LLM reads the thread the
//   way the user lived it.
//
// Fail-soft: callers should wrap in try/catch so a DB hiccup never kills a
// job — at worst the agent loses session continuity for that turn.

import { eq, and, ne, gt, desc, inArray } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import type { ModelMessage } from 'ai';
import type { RunnerDeps } from '../deps.ts';

/**
 * Channels that represent ongoing conversations. Others (`api`, `cron`,
 * `task-board`, `internal`) are one-shot invocations and never get prior
 * history injected.
 */
const CONVERSATIONAL_CHANNELS: ReadonlySet<string> = new Set(['telegram', 'slack', 'discord']);

/** Max prior (user, assistant) pairs to load. */
const MAX_TURNS = 5;
/** Total char budget across all loaded pairs. ~4000 chars ≈ ~1000 tokens. */
const BUDGET_CHARS = 4_000;
/** Per-message char cap — any single turn longer than this is truncated. */
const PER_TURN_MAX_CHARS = 2_000;
/**
 * Idle reset GAP. A silence of at least this long between two consecutive turns
 * (or between the most recent prior turn and now) starts a FRESH conversation —
 * everything before the gap is dropped. This is a true session reset, not a
 * rolling window: a thread the user comes back to after a break starts clean
 * (a 12h-old exchange is NOT context for a brand-new request).
 */
const IDLE_RESET_MINUTES = 30;
const IDLE_RESET_MS = IDLE_RESET_MINUTES * 60_000;
/**
 * Outer query bound — never scan rows older than this. Pure optimization to cap
 * the candidate scan; the real session boundary is the gap logic, not this.
 */
const MAX_LOOKBACK_MS = 24 * 60 * 60_000;

export interface LoadThreadHistoryOptions {
  db: RunnerDeps['db'];
  entityId: string;
  agentId: string;
  /** Job's `channel` column — `telegram`, `slack`, etc. */
  channel: string;
  /** Job's `chat_id` column — the thread identifier on the channel. */
  chatId: string;
  /** Current job's id — excluded from the prior-history query. */
  excludeJobId: string;
}

/**
 * Load recent prior turns from the same chat thread, formatted as
 * `ModelMessage[]` ready to prepend to the current job's messages array.
 *
 * Returns `[]` (no error thrown) when:
 * - The channel is not conversational.
 * - `chatId` is empty.
 * - No completed prior jobs within the idle window.
 * - All candidate jobs have null/empty `result` (e.g. all soft-skipped).
 */
export async function loadThreadHistory(opts: LoadThreadHistoryOptions): Promise<ModelMessage[]> {
  if (!CONVERSATIONAL_CHANNELS.has(opts.channel)) return [];
  if (!opts.chatId) return [];

  const now = Date.now();
  const cutoff = new Date(now - MAX_LOOKBACK_MS);

  const rows = await opts.db
    .select({
      task: agentJobs.task,
      result: agentJobs.result,
      messages: agentJobs.messages,
      channel: agentJobs.channel,
      createdAt: agentJobs.createdAt,
    })
    .from(agentJobs)
    .where(
      and(
        eq(agentJobs.entityId, opts.entityId),
        eq(agentJobs.agentId, opts.agentId),
        eq(agentJobs.channel, opts.channel),
        eq(agentJobs.chatId, opts.chatId),
        // Terminal jobs that produced a user-facing turn — NOT just 'completed'.
        // A job that FAILED (e.g. the agent asked the user to launch ComfyUI, so
        // the generation couldn't finish) still DELIVERED a message the user saw
        // and replied to. Excluding it broke continuity: on the user's reply the
        // agent had no memory of what it had asked. extractAssistantReply returns
        // null for failed jobs with no usable result, so silent internal failures
        // are still skipped — only failures that spoke to the user are carried.
        inArray(agentJobs.status, ['completed', 'failed']),
        ne(agentJobs.id, opts.excludeJobId),
        gt(agentJobs.createdAt, cutoff),
      ),
    )
    .orderBy(desc(agentJobs.createdAt))
    .limit(MAX_TURNS);

  // Gap-based session reset. Walk newest->oldest and keep turns only while the
  // silence between consecutive turns stays under IDLE_RESET. Stop at the first
  // gap (a session boundary). If the most recent prior turn is itself older than
  // IDLE_RESET, the loop breaks on the very first row → no history at all (the
  // thread went idle, so this message opens a fresh conversation).
  const session: typeof rows = [];
  let newerAt = now;
  for (const row of rows) {
    const at = new Date(row.createdAt as unknown as string | number | Date).getTime();
    if (newerAt - at >= IDLE_RESET_MS) break;
    session.push(row);
    newerAt = at;
  }

  // Flip to chronological (oldest first) so the budget loop drops the OLDEST
  // blocks first.
  const chronological = session.reverse();

  // Each "block" is a contiguous slice of messages we keep or drop together
  // — either a 2-message `[user, assistant-text]` pair (no send-tool path)
  // or a 3-message `[user, assistant-tool-call, tool-result]` block (when
  // the channel has a send-tool mapping, e.g. telegram). The 3-message
  // shape is required so the LLM sees "reply via the channel send tool"
  // as the prior pattern and keeps using it on the current turn — a
  // text-only assistant shape was empirically observed to teach the LLM
  // to skip the tool entirely (job c25447d8, 2026-05-25).
  let nextSynthId = 0;
  const blocks: ModelMessage[][] = [];
  for (const row of chronological) {
    const assistant = extractAssistantReply({
      task: row.task,
      result: row.result,
      messages: row.messages,
      channel: row.channel,
    });
    if (assistant === null) continue;
    const sendTool = CHANNEL_SEND_TOOL[row.channel];
    if (sendTool) {
      const callId = `history-tool-${nextSynthId++}`;
      blocks.push([
        { role: 'user', content: truncate(row.task) },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: callId,
              toolName: sendTool,
              input: { text: truncate(assistant) },
            },
          ],
        } as ModelMessage,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              toolName: sendTool,
              output: { type: 'json', value: { messageId: 'history' } },
            },
          ],
        } as ModelMessage,
      ]);
    } else {
      blocks.push([
        { role: 'user', content: truncate(row.task) },
        { role: 'assistant', content: truncate(assistant) },
      ]);
    }
  }

  // Apply total char budget: drop oldest blocks (from the front) until under.
  // Each iteration drops one full block — never leaves orphan tool-results
  // or unpaired assistant tool-calls behind.
  while (blocks.length > 0 && totalChars(blocks) > BUDGET_CHARS) {
    blocks.shift();
  }

  return blocks.flatMap((b) => b);
}

/**
 * Map of channel → the tool the agent uses to emit a user-visible reply.
 * For conversational channels, the user-facing text typically lives inside
 * a `*_send_message` tool call rather than in `return_result` — the agent
 * delivers the answer through the channel API directly, and only acks via
 * `return_result({status: 'success'})` with no text. Without this lookup we
 * lose the user-visible reply and the next turn's session-memory context
 * comes back empty.
 */
const CHANNEL_SEND_TOOL: Readonly<Record<string, string>> = {
  telegram: 'telegram_send_message',
};

/**
 * Resolve the assistant's user-visible reply for a prior job, using a
 * fallback chain (rationale in the file header):
 *   1. `result` column when populated — long-form return_result with text.
 *   2. Concatenated `text` from every `<channel>_send_message` tool call in
 *      the messages array (the actual user-visible reply for conversational
 *      channels).
 *   3. Last assistant message's text content — covers exotic flows that
 *      neither populated `result` nor used the channel send tool.
 *   4. `null` to signal "skip this job".
 *
 * Important — session-memory chaining defense: each prior job's `messages`
 * JSONB contains BOTH its own turns AND the history that was injected into
 * IT when it ran (a chain effect). When we extract a reply via fallbacks
 * #2 / #3, we must restrict the search to the prior job's OWN turns,
 * otherwise we surface text from much older jobs and the per-turn
 * truncation chops the actually-relevant tail. The boundary is the user
 * message whose content equals `agent_jobs.task` — everything from that
 * index onwards is the job's own content. Empirically observed on job
 * 9c22d5b3 (2026-05-26) where 3 Stripe-related prior jobs all returned
 * the same stale Cortex pre-amble before this fix.
 */
function extractAssistantReply(row: {
  task: string;
  result: string | null;
  messages: unknown;
  channel: string;
}): string | null {
  // 1. result column.
  if (row.result !== null && row.result !== undefined && row.result.trim() !== '') {
    return row.result;
  }

  const allMessages = Array.isArray(row.messages) ? (row.messages as ModelMessage[]) : [];

  // Locate the boundary between injected history and the job's own turns.
  // Search backward from the end so we land on the LAST occurrence of the
  // current task — defensive against duplicate user messages (rare).
  let currentStart = 0;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const m = allMessages[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string' && c === row.task) {
      currentStart = i;
      break;
    }
  }
  const messages = allMessages.slice(currentStart);

  // 2. channel-specific send-message tool calls (within current-job slice).
  const sendTool = CHANNEL_SEND_TOOL[row.channel];
  if (sendTool) {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as { type?: unknown; toolName?: unknown; input?: unknown };
        if (part.type !== 'tool-call' || part.toolName !== sendTool) continue;
        const input = part.input;
        if (input && typeof input === 'object' && 'text' in input) {
          const text = (input as { text: unknown }).text;
          if (typeof text === 'string' && text.trim() !== '') parts.push(text);
        }
      }
    }
    if (parts.length > 0) return parts.join('\n\n');
  }

  // 3. last assistant text content (within current-job slice).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    const content = msg.content;
    if (typeof content === 'string' && content.trim() !== '') return content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as { type?: unknown; text?: unknown };
        if (part.type === 'text' && typeof part.text === 'string') textParts.push(part.text);
      }
      const joined = textParts.join('');
      if (joined.trim() !== '') return joined;
    }
  }

  // 4. nothing to show.
  return null;
}

function truncate(s: string): string {
  if (s.length <= PER_TURN_MAX_CHARS) return s;
  return s.slice(0, PER_TURN_MAX_CHARS) + ' [… truncated]';
}

function totalChars(blocks: ReadonlyArray<ReadonlyArray<ModelMessage>>): number {
  let total = 0;
  for (const block of blocks) {
    for (const msg of block) {
      const content = msg.content;
      if (typeof content === 'string') {
        total += content.length;
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as { type?: unknown; text?: unknown; input?: unknown };
        if (part.type === 'text' && typeof part.text === 'string') {
          total += part.text.length;
        } else if (part.type === 'tool-call' && part.input && typeof part.input === 'object') {
          const text = (part.input as { text?: unknown }).text;
          if (typeof text === 'string') total += text.length;
        }
        // tool-result parts (synthetic) contribute negligible chars; ignore
        // in the budget so a couple of tokens of JSON acks don't push us over.
      }
    }
  }
  return total;
}
