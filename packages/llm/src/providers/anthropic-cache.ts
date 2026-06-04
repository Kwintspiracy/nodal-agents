// @nodal-agents/llm — Anthropic prompt-cache wiring.
//
// Anthropic does NOT auto-cache (unlike DeepSeek / OpenRouter, which cache a
// repeated prefix transparently). To get the ~10x cost reduction Claude Cowork
// enjoys, the request itself must carry `cache_control` breakpoints. The AI SDK
// reads `providerOptions.anthropic.cacheControl` from (a) a system message and
// (b) the last part of the last message (falling back to message-level
// providerOptions — see @ai-sdk/anthropic convert-to-anthropic-messages-prompt).
//
// We set two ephemeral breakpoints:
//   1. the system prompt — large and byte-identical every turn;
//   2. the LAST message of the array — a SLIDING breakpoint, so the entire
//      conversation prefix up to this turn is cached and only the next turn's
//      delta is fresh.
//
// Net effect: each turn re-reads the growing transcript from cache instead of
// re-paying it as fresh input. That shows up in usage.cachedInputTokens, which
// the cache-aware budget (runner Guard 1a) then credits — so a long Claude job
// stays cheap AND well under the token budget, exactly like Cowork.

import type { ModelMessage } from 'ai';

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

/**
 * Annotate generateText/streamText args with Anthropic cache_control breakpoints.
 * Pure: returns a new args object, never mutates the input. The caller gates this
 * on `provider === 'anthropic' && capabilities.promptCaching` so non-Anthropic
 * providers keep their plain `system` string untouched. Generic over the full
 * args type so tools / toolChoice / every other field passes through unchanged.
 */
export function withAnthropicPromptCaching<T extends object>(args: T): T {
  const view = args as { system?: unknown; messages?: unknown };
  const original: ModelMessage[] = Array.isArray(view.messages)
    ? (view.messages as ModelMessage[])
    : [];

  // Sliding breakpoint: cache_control on the LAST message (the SDK applies it to
  // that message's last content part). Caches the whole prefix up to here.
  const messages: ModelMessage[] =
    original.length > 0
      ? original.map((m, i) =>
          i === original.length - 1
            ? ({
                ...m,
                providerOptions: { ...(m.providerOptions ?? {}), ...EPHEMERAL },
              } as ModelMessage)
            : m,
        )
      : original;

  // Promote a top-level `system` string to a cached system message so the (large,
  // stable) system prompt is cached too. Anthropic-only transform.
  if (typeof view.system === 'string' && view.system.length > 0) {
    const systemMsg = {
      role: 'system',
      content: view.system,
      providerOptions: EPHEMERAL,
    } as unknown as ModelMessage;
    const rest = { ...args } as { system?: unknown };
    delete rest.system;
    return { ...(rest as T), messages: [systemMsg, ...messages] } as T;
  }

  return { ...args, messages } as T;
}
