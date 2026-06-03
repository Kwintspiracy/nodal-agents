// model-catalog.test.ts — context-window lookup (drives runtime compaction).

import { describe, it, expect } from 'vitest';
import { modelContextWindow, DEFAULT_CONTEXT_WINDOW, MODEL_CATALOG } from '../model-catalog';

describe('modelContextWindow', () => {
  it('returns the catalogued window for known models', () => {
    expect(modelContextWindow('openrouter', 'deepseek/deepseek-v3.2')).toBe(131_072);
    expect(modelContextWindow('openrouter', 'minimax/minimax-m3')).toBe(1_048_576);
    expect(modelContextWindow('anthropic', 'claude-opus-4-8')).toBe(200_000);
  });

  it('falls back to the conservative default for custom/unknown models', () => {
    expect(modelContextWindow('openrouter', 'some/unknown-model')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelContextWindow('openai-compatible', 'local-model')).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('every catalogued model declares a positive context window', () => {
    // Guards against adding a model without its window — compaction would then
    // silently fall back to the conservative default for it.
    for (const [provider, entries] of Object.entries(MODEL_CATALOG)) {
      for (const e of entries) {
        expect(e.contextWindow, `${provider}/${e.modelId}`).toBeGreaterThan(0);
      }
    }
  });
});
