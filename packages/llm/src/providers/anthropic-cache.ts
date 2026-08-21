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
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from '@nodal-agents/shared';

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

/**
 * Annotate generateText/streamText args with Anthropic cache_control breakpoints.
 * Pure: returns a new args object, never mutates the input. The caller gates this
 * on `provider === 'anthropic' && capabilities.promptCaching` so non-Anthropic
 * providers keep their plain `system` string untouched. Generic over the full
 * args type so tools / toolChoice / every other field passes through unchanged.
 */
export function withAnthropicPromptCaching<T extends object>(args: T): T {
  const view = args as { system?: unknown; messages?: unknown; prompt?: unknown };

  // The AI SDK accepts EITHER `prompt` (a bare string) OR `messages`, never
  // both — passing both is a hard rejection, not a degradation:
  // "Invalid prompt: prompt and messages cannot be defined at the same time".
  //
  // This function used to append `messages` unconditionally, so a caller using
  // the documented `prompt` shorthand against an Anthropic client had EVERY
  // call fail. Nothing in the runner hits it today (it always builds
  // `messages`), which is why it went unnoticed — the model-conformance suite
  // found it on its first run against the native Anthropic harness.
  //
  // A bare `prompt` has no message array to hang a sliding breakpoint on, so
  // there is nothing to annotate: pass it through untouched.
  if (view.prompt !== undefined && !Array.isArray(view.messages)) {
    return args;
  }

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

  // Promote a top-level `system` string to cached system message(s). If the
  // prompt carries SYSTEM_PROMPT_CACHE_BOUNDARY (E1), split it: the STABLE prefix
  // gets the ephemeral breakpoint (reused across the agent's jobs), and the
  // VOLATILE tail (live timestamp, per-job memory/context) rides as a SECOND,
  // UNCACHED system message so it never invalidates the cached prefix. Without
  // the marker, the whole system is cached as one block (unchanged behavior).
  if (typeof view.system === 'string' && view.system.length > 0) {
    const boundary = view.system.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const systemMsgs: ModelMessage[] =
      boundary >= 0
        ? [
            {
              role: 'system',
              content: view.system.slice(0, boundary),
              providerOptions: EPHEMERAL,
            } as unknown as ModelMessage,
            {
              role: 'system',
              content: view.system.slice(boundary + SYSTEM_PROMPT_CACHE_BOUNDARY.length),
            } as unknown as ModelMessage,
          ]
        : [
            {
              role: 'system',
              content: view.system,
              providerOptions: EPHEMERAL,
            } as unknown as ModelMessage,
          ];
    const rest = { ...args } as { system?: unknown };
    delete rest.system;
    return { ...(rest as T), messages: [...systemMsgs, ...messages] } as T;
  }

  return { ...args, messages } as T;
}

/**
 * Strip the E1 cache boundary marker from a plain `system` string. Applied on
 * the NON-caching path (non-Anthropic providers) so the marker — which only the
 * Anthropic split consumes — never leaks into the prompt those providers see.
 */
export function stripSystemCacheBoundary<T extends object>(args: T): T {
  const view = args as { system?: unknown };
  if (typeof view.system !== 'string' || !view.system.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)) {
    return args;
  }
  return { ...args, system: view.system.split(SYSTEM_PROMPT_CACHE_BOUNDARY).join('\n\n') } as T;
}
