import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { withAnthropicPromptCaching, stripSystemCacheBoundary } from '../providers/anthropic-cache';
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from '@nodal-agents/shared';

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

describe('withAnthropicPromptCaching', () => {
  it('promotes the system string to a cached system message and drops top-level system', () => {
    const out = withAnthropicPromptCaching({
      system: 'You are a helpful agent.',
      messages: [{ role: 'user', content: 'hi' }] as ModelMessage[],
    });

    // system string is gone, replaced by a leading cached system message
    expect((out as { system?: unknown }).system).toBeUndefined();
    const first = out.messages[0] as ModelMessage & { providerOptions?: unknown };
    expect(first.role).toBe('system');
    expect((first as { content?: unknown }).content).toBe('You are a helpful agent.');
    expect(first.providerOptions).toEqual(EPHEMERAL);
  });

  it('splits on the cache boundary: stable prefix cached, volatile tail NOT cached (E1)', () => {
    const system = `STABLE PREFIX${SYSTEM_PROMPT_CACHE_BOUNDARY}VOLATILE TAIL`;
    const out = withAnthropicPromptCaching({
      system,
      messages: [{ role: 'user', content: 'hi' }] as ModelMessage[],
    });

    expect((out as { system?: unknown }).system).toBeUndefined();
    const [m0, m1] = out.messages as Array<ModelMessage & { providerOptions?: unknown }>;
    // Stable prefix → first system message, WITH the ephemeral breakpoint.
    expect(m0!.role).toBe('system');
    expect((m0 as { content?: unknown }).content).toBe('STABLE PREFIX');
    expect(m0!.providerOptions).toEqual(EPHEMERAL);
    // Volatile tail → second system message, NO cache control (it changes per job).
    expect(m1!.role).toBe('system');
    expect((m1 as { content?: unknown }).content).toBe('VOLATILE TAIL');
    expect(m1!.providerOptions).toBeUndefined();
  });

  it('stripSystemCacheBoundary removes the marker for the non-caching path', () => {
    const system = `A${SYSTEM_PROMPT_CACHE_BOUNDARY}B`;
    const out = stripSystemCacheBoundary({ system, messages: [] });
    expect((out as { system: string }).system).toBe('A\n\nB');
    expect((out as { system: string }).system).not.toContain('NODAL_SYSTEM_CACHE_BOUNDARY');
  });

  it('puts a sliding cache breakpoint on the LAST message only', () => {
    const out = withAnthropicPromptCaching({
      system: 'sys',
      messages: [
        { role: 'user', content: 'turn1' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'turn2' },
      ] as ModelMessage[],
    });

    // [system, user1, assistant, user2] — only the genuinely last message carries it
    const msgs = out.messages as Array<ModelMessage & { providerOptions?: unknown }>;
    expect(msgs).toHaveLength(4);
    expect(msgs[1]?.providerOptions).toBeUndefined(); // user1
    expect(msgs[2]?.providerOptions).toBeUndefined(); // assistant
    expect(msgs[3]?.providerOptions).toEqual(EPHEMERAL); // user2 (last)
  });

  it('merges with existing message-level providerOptions, not clobbering them', () => {
    const out = withAnthropicPromptCaching({
      messages: [
        { role: 'user', content: 'x', providerOptions: { openrouter: { foo: 1 } } },
      ] as unknown as ModelMessage[],
    });
    const last = out.messages[0] as ModelMessage & { providerOptions?: Record<string, unknown> };
    expect(last.providerOptions).toEqual({ openrouter: { foo: 1 }, ...EPHEMERAL });
  });

  it('does not mutate the input args or messages', () => {
    const messages = [{ role: 'user', content: 'hi' }] as ModelMessage[];
    const args = { system: 'sys', messages };
    const out = withAnthropicPromptCaching(args);
    expect(args.system).toBe('sys'); // original untouched
    expect((messages[0] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    expect(out.messages).not.toBe(messages);
  });

  it('is a no-op shape (empty messages) without throwing when there is nothing to annotate', () => {
    const out = withAnthropicPromptCaching({ messages: [] as ModelMessage[] });
    expect(out.messages).toEqual([]);
  });
});

describe('withAnthropicPromptCaching — `prompt` shorthand (regression)', () => {
  // Found by the model-conformance suite on its first run against the native
  // Anthropic harness. The AI SDK accepts EITHER `prompt` OR `messages`, never
  // both; this helper used to append `messages` unconditionally, so every call
  // using the documented `prompt` shorthand failed outright with
  // "Invalid prompt: prompt and messages cannot be defined at the same time".
  //
  // Latent rather than live — the runner always builds `messages` — but a trap
  // for the next caller.

  it('leaves a bare `prompt` untouched instead of adding an empty messages array', () => {
    const out = withAnthropicPromptCaching({ prompt: 'Réponds: OK', maxOutputTokens: 16 }) as {
      prompt?: unknown;
      messages?: unknown;
    };
    expect(out.prompt).toBe('Réponds: OK');
    expect(out.messages).toBeUndefined();
  });

  it('leaves a `prompt` + `system` pair untouched — no system promotion either', () => {
    // Promoting `system` to a system MESSAGE would reintroduce the same
    // conflict by another route.
    const out = withAnthropicPromptCaching({ prompt: 'x', system: 'Tu es un agent.' }) as {
      prompt?: unknown;
      messages?: unknown;
      system?: unknown;
    };
    expect(out.prompt).toBe('x');
    expect(out.system).toBe('Tu es un agent.');
    expect(out.messages).toBeUndefined();
  });

  it('still annotates when `messages` is present, even alongside a stray prompt key', () => {
    const out = withAnthropicPromptCaching({
      messages: [{ role: 'user', content: 'hi' }],
    }) as { messages?: Array<{ providerOptions?: unknown }> };
    expect(out.messages).toHaveLength(1);
    expect(out.messages?.[0]?.providerOptions).toBeDefined();
  });
});
