// @nodal-agents/llm — the two clocks of a streamed turn (#440)
//
// A turn of the job loop used to be ONE `generateText` call under a wall-clock
// budget (300 s, then a 150 s stale retry). A writing turn of several thousand
// tokens on a model at 40 tokens/s was cut off WHILE IT WROTE, and nothing it
// had written survived (#439, run 531c2692). A streamed turn has no working
// wall clock. It has two silence clocks, because the two silences of a call
// are not the same thing:
//
//  1. the wait for the FIRST token — prefill plus hidden thinking. It grows
//     with the context and with a high reasoning effort;
//  2. the silence BETWEEN tokens — once the model writes, a minute of silence
//     is a dead connection or a dead provider, not thinking. Fixed.
//
// Every chunk the model sends resets the running clock, reasoning deltas
// included: a model thinking out loud for ten minutes trips nothing. On a
// local endpoint neither clock applies (Hermes: `is_local_endpoint → inf`,
// run_agent.py:588) — a local model on a small machine is slow, not dead.
// The only thing that ends a call still producing is the absolute net below,
// far above any real call, and the run budget (#442).
//
// What the stream wrote before a clock fired is never thrown away: it travels
// on the `LLMTimeoutError` (`partialText`), and the runner resumes the turn
// from it instead of replaying it (#441).

import type { generateText, streamText } from 'ai';

import type { ProviderConfig } from './types';
import { LLMTimeoutError } from './errors';
import type { LlmTimeoutReason } from './errors';

// ─── Defaults ──────────────────────────────────────────────────────────────────

/** Wait for the first token, base. Calibrated on the 38-47 tokens/s of run 531c2692. */
export const FIRST_TOKEN_BASE_MS = 120_000;
/** Above 50K tokens of context (Hermes run_agent.py:593 grows it the same way). */
export const FIRST_TOKEN_OVER_50K_MS = 150_000;
/** Above 100K tokens of context. */
export const FIRST_TOKEN_OVER_100K_MS = 240_000;
/** Floor on a `high` reasoning effort: the hidden thinking comes before the first token. */
export const FIRST_TOKEN_HIGH_EFFORT_MS = 300_000;
/** Floor on a `max` reasoning effort. */
export const FIRST_TOKEN_MAX_EFFORT_MS = 600_000;
/** Silence between two tokens. Never raised by context, effort or an explicit value. */
export const BETWEEN_TOKENS_MS = 60_000;
/** The absolute net of one call: never the working limit, only the end of a call that hangs while "producing". */
export const ABSOLUTE_CALL_MS = 3_600_000;

export interface TurnClocks {
  /** Wait for the first token; `Infinity` = no limit. */
  firstTokenMs: number;
  /** Silence allowed between two tokens; `Infinity` = no limit. */
  betweenTokensMs: number;
  /** Total duration of one call, whatever it produces. */
  absoluteMs: number;
}

// ─── Local endpoint ────────────────────────────────────────────────────────────

/**
 * True when the model runs on the user's machine or network: Ollama, or a base
 * URL whose host is loopback, a private range or a `.local` name. Only the
 * host decides; a hosted provider's default URL is never local.
 */
export function isLocalEndpoint(config: Pick<ProviderConfig, 'provider' | 'baseURL'>): boolean {
  if (config.provider === 'ollama') return true;
  if (!config.baseURL) return false;
  let host: string;
  try {
    host = new URL(config.baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  return false;
}

// ─── Context size ──────────────────────────────────────────────────────────────

/**
 * Rough token count of what a call sends: characters / 4 over the system
 * prompt and every textual part of the messages. Images and files are not
 * counted — their bytes say nothing about prefill time. It only picks a tier
 * (50K / 100K), so a rough count is all it needs.
 */
export function estimateContextTokens(args: { system?: unknown; messages?: unknown }): number {
  let chars = 0;
  const add = (v: unknown): void => {
    if (typeof v === 'string') {
      chars += v.length;
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) add(item);
      return;
    }
    if (v && typeof v === 'object') {
      const part = v as Record<string, unknown>;
      if (part['type'] === 'image' || part['type'] === 'file') return;
      if (typeof part['text'] === 'string') {
        chars += part['text'].length;
        return;
      }
      if ('content' in part) {
        add(part['content']);
        return;
      }
      try {
        chars += JSON.stringify(part).length;
      } catch {
        // A value that cannot be serialised adds nothing to the estimate.
      }
    }
  };
  add(args.system);
  add(args.messages);
  return Math.ceil(chars / 4);
}

// ─── Clocks ────────────────────────────────────────────────────────────────────

/** The clocks of one streamed call, from the model config and the size of what it sends. */
export function computeTurnClocks(
  config: Pick<ProviderConfig, 'provider' | 'baseURL' | 'reasoningEffort'>,
  contextTokens: number,
): TurnClocks {
  if (isLocalEndpoint(config)) {
    return { firstTokenMs: Infinity, betweenTokensMs: Infinity, absoluteMs: ABSOLUTE_CALL_MS };
  }
  let firstTokenMs =
    contextTokens > 100_000
      ? FIRST_TOKEN_OVER_100K_MS
      : contextTokens > 50_000
        ? FIRST_TOKEN_OVER_50K_MS
        : FIRST_TOKEN_BASE_MS;
  if (config.reasoningEffort === 'high')
    firstTokenMs = Math.max(firstTokenMs, FIRST_TOKEN_HIGH_EFFORT_MS);
  if (config.reasoningEffort === 'max')
    firstTokenMs = Math.max(firstTokenMs, FIRST_TOKEN_MAX_EFFORT_MS);
  return { firstTokenMs, betweenTokensMs: BETWEEN_TOKENS_MS, absoluteMs: ABSOLUTE_CALL_MS };
}

// ─── Consuming a stream under the clocks ───────────────────────────────────────

type StreamResult = ReturnType<typeof streamText>;
type GenerateResult = Awaited<ReturnType<typeof generateText>>;

/**
 * Parts the SDK emits on its own, before or after the model speaks. They say
 * nothing about the model being alive, so they reset no clock.
 */
const FRAMING_PARTS = new Set(['start', 'start-step', 'finish-step', 'finish', 'abort', 'error']);

/**
 * Run one streamed call under its clocks and hand back the same result a
 * `generateText` call would have produced — the job loop reads `text`,
 * `toolCalls`, `reasoning`, `usage`, `providerMetadata` and nothing else
 * changes for it.
 *
 * `start(signal)` starts the stream with the abort signal the clocks own.
 * When a clock fires the call is aborted and `LLMTimeoutError` is thrown with
 * the reason and the text received so far. A stream error part is thrown as
 * the error it carries, so the retry, floor and failover layers above see
 * exactly what `generateText` used to throw.
 */
export async function consumeUnderClocks(
  start: (signal: AbortSignal) => StreamResult,
  clocks: TurnClocks,
  providerModel: { provider: string; model: string },
): Promise<GenerateResult> {
  const controller = new AbortController();
  let expired: { reason: LlmTimeoutReason; limitMs: number } | null = null;
  let partialText = '';
  let sawModel = false;

  // Aborting the request is not enough on its own: the SDK only notices the
  // signal when a chunk moves, so a stream that stays mute would keep the loop
  // waiting forever (verified on ai 6.0.177 with a mock that never speaks).
  // The loop therefore races every read against the expiry itself.
  let onExpired: () => void = () => {};
  const expiredSignal = new Promise<'expired'>((resolve) => {
    onExpired = () => resolve('expired');
  });

  const expire = (reason: LlmTimeoutReason, limitMs: number): void => {
    if (expired) return;
    expired = { reason, limitMs };
    controller.abort();
    onExpired();
  };

  let silence: ReturnType<typeof setTimeout> | undefined;
  const armSilence = (): void => {
    if (silence !== undefined) clearTimeout(silence);
    silence = undefined;
    const limitMs = sawModel ? clocks.betweenTokensMs : clocks.firstTokenMs;
    if (!Number.isFinite(limitMs)) return;
    const reason: LlmTimeoutReason = sawModel ? 'idle_between_tokens' : 'idle_before_first_token';
    silence = setTimeout(() => expire(reason, limitMs), limitMs);
  };
  const absolute = setTimeout(() => expire('absolute', clocks.absoluteMs), clocks.absoluteMs);

  armSilence();
  try {
    const stream = start(controller.signal);
    const parts = stream.fullStream[Symbol.asyncIterator]();
    try {
      while (true) {
        const read = parts.next();
        // A read still pending when the clock fires settles later, into nothing.
        read.catch(() => {});
        const next = await Promise.race([read, expiredSignal]);
        if (next === 'expired') {
          void parts.return?.()?.catch(() => {});
          break;
        }
        if (next.done) break;
        const part = next.value;
        if (part.type === 'error') throw part.error;
        if (FRAMING_PARTS.has(part.type)) continue;
        if (part.type === 'text-delta') partialText += part.text;
        sawModel = true;
        armSilence();
      }
    } catch (err) {
      if (!expired) throw err;
    }
    if (expired !== null) {
      const { reason, limitMs } = expired;
      throw new LLMTimeoutError(providerModel.provider, providerModel.model, limitMs, {
        reason,
        partialText,
      });
    }
    return await collectResult(stream);
  } finally {
    if (silence !== undefined) clearTimeout(silence);
    clearTimeout(absolute);
  }
}

/** The generateText-shaped result of a finished stream. */
async function collectResult(stream: StreamResult): Promise<GenerateResult> {
  const [
    content,
    text,
    reasoning,
    reasoningText,
    files,
    sources,
    toolCalls,
    staticToolCalls,
    dynamicToolCalls,
    toolResults,
    staticToolResults,
    dynamicToolResults,
    finishReason,
    rawFinishReason,
    usage,
    totalUsage,
    warnings,
    request,
    response,
    providerMetadata,
    steps,
  ] = await Promise.all([
    stream.content,
    stream.text,
    stream.reasoning,
    stream.reasoningText,
    stream.files,
    stream.sources,
    stream.toolCalls,
    stream.staticToolCalls,
    stream.dynamicToolCalls,
    stream.toolResults,
    stream.staticToolResults,
    stream.dynamicToolResults,
    stream.finishReason,
    stream.rawFinishReason,
    stream.usage,
    stream.totalUsage,
    stream.warnings,
    stream.request,
    stream.response,
    stream.providerMetadata,
    stream.steps,
  ]);
  return {
    content,
    text,
    reasoning,
    reasoningText,
    files,
    sources,
    toolCalls,
    staticToolCalls,
    dynamicToolCalls,
    toolResults,
    staticToolResults,
    dynamicToolResults,
    finishReason,
    rawFinishReason,
    usage,
    totalUsage,
    warnings,
    request,
    response: { ...response, messages: response.messages },
    providerMetadata,
    steps,
  } as unknown as GenerateResult;
}
