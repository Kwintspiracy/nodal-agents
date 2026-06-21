// model-catalog.test.ts — context-window lookup (drives runtime compaction)
// and providerOrder routing preference (P0-C, Part 2).

import { describe, it, expect } from 'vitest';
import {
  modelContextWindow,
  DEFAULT_CONTEXT_WINDOW,
  MODEL_CATALOG,
  findModelCatalogEntry,
} from '../model-catalog';

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

// ─── providerOrder routing preference (P0-C / Part 2) ────────────────────────

describe('providerOrder', () => {
  it('deepseek/deepseek-v4-pro has providerOrder: ["deepseek"]', () => {
    const entry = findModelCatalogEntry('openrouter', 'deepseek/deepseek-v4-pro');
    expect(entry).toBeDefined();
    expect(entry?.providerOrder).toEqual(['deepseek']);
  });

  it('deepseek/deepseek-v4-flash has providerOrder: ["deepseek"]', () => {
    const entry = findModelCatalogEntry('openrouter', 'deepseek/deepseek-v4-flash');
    expect(entry).toBeDefined();
    expect(entry?.providerOrder).toEqual(['deepseek']);
  });

  it('non-DeepSeek entries have no providerOrder (anthropic/claude-sonnet-4.6)', () => {
    const entry = findModelCatalogEntry('openrouter', 'anthropic/claude-sonnet-4.6');
    expect(entry).toBeDefined();
    expect(entry?.providerOrder).toBeUndefined();
  });

  it('deepseek/deepseek-v3.2 (older model) has no providerOrder', () => {
    const entry = findModelCatalogEntry('openrouter', 'deepseek/deepseek-v3.2');
    expect(entry).toBeDefined();
    expect(entry?.providerOrder).toBeUndefined();
  });
});
