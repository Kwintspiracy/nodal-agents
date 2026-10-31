// prompt-caching-for.test.ts — which (provider, model) gets cache breakpoints (#425)

import { describe, it, expect } from 'vitest';
import { promptCachingFor, capabilitiesFor, CAPABILITY_MATRIX } from '../providers/registry';
import { markCacheBreakpointsInParts } from '../providers/openrouter';

describe('promptCachingFor @cap:voir-le-cout/moteur', () => {
  it('follows the model through every route that reaches it', () => {
    expect(promptCachingFor('anthropic', 'claude-sonnet-5')).toBe(true);
    expect(promptCachingFor('openrouter', 'anthropic/claude-sonnet-5.5')).toBe(true);
    expect(promptCachingFor('openrouter', 'anthropic/claude-haiku-4.5')).toBe(true);
  });

  it('is false for a model that caches on its own or is unknown, on the route that carries many vendors', () => {
    expect(promptCachingFor('openrouter', 'z-ai/glm-5.2')).toBe(false);
    expect(promptCachingFor('openrouter', 'deepseek/deepseek-v3.2')).toBe(false);
    expect(promptCachingFor('openrouter', 'anthropic/claude-not-in-the-catalog-9')).toBe(false);
  });

  it('keeps the native Anthropic default for a model id the catalog does not know', () => {
    expect(promptCachingFor('anthropic', 'claude-a-future-model-9')).toBe(true);
  });

  it('does not change the other providers', () => {
    for (const p of ['openai', 'google', 'ollama', 'deepseek', 'minimax', 'moonshot'] as const) {
      expect(promptCachingFor(p, 'whatever-model'), p).toBe(false);
    }
  });

  it('capabilitiesFor only resolves promptCaching, the other flags are the provider row', () => {
    const caps = capabilitiesFor('openrouter', 'anthropic/claude-sonnet-5.5');
    expect(caps).toEqual({ ...CAPABILITY_MATRIX.openrouter, promptCaching: true });
  });
});

describe('markCacheBreakpointsInParts @cap:voir-le-cout/moteur', () => {
  const M = { type: 'ephemeral' };

  it('moves a top-level marker of a tool message into its content part', () => {
    expect(
      markCacheBreakpointsInParts([
        { role: 'tool', tool_call_id: 'c', content: 'result', cache_control: M },
      ]),
    ).toEqual([
      {
        role: 'tool',
        tool_call_id: 'c',
        content: [{ type: 'text', text: 'result', cache_control: M }],
      },
    ]);
  });

  it('marks the last part of an array content', () => {
    expect(
      markCacheBreakpointsInParts([
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
          cache_control: M,
        },
      ]),
    ).toEqual([
      {
        role: 'tool',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b', cache_control: M },
        ],
      },
    ]);
  });

  it('drops a marker that has nothing to hang on (empty assistant turn)', () => {
    expect(
      markCacheBreakpointsInParts([{ role: 'assistant', content: '', cache_control: M }]),
    ).toEqual([{ role: 'assistant', content: '' }]);
  });

  it('keeps one marker for a run of tool messages: the last', () => {
    const out = markCacheBreakpointsInParts([
      { role: 'tool', content: 'r1', cache_control: M },
      { role: 'tool', content: 'r2', cache_control: M },
      { role: 'tool', content: 'r3', cache_control: M },
    ]);
    expect(out).toEqual([
      { role: 'tool', content: 'r1' },
      { role: 'tool', content: 'r2' },
      { role: 'tool', content: [{ type: 'text', text: 'r3', cache_control: M }] },
    ]);
  });

  it('leaves a request without a top-level marker byte for byte as it was', () => {
    const msgs = [
      { role: 'system', content: [{ type: 'text', text: 's', cache_control: M }] },
      { role: 'user', content: 'u' },
    ];
    expect(markCacheBreakpointsInParts(msgs)).toEqual(msgs);
  });
});
