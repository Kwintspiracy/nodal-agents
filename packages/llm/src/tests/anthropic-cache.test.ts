import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { withAnthropicPromptCaching } from '../providers/anthropic-cache';

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
