// model-catalog.test.ts — context-window lookup (drives runtime compaction)
// and providerOrder routing preference (P0-C, Part 2).

import { describe, it, expect } from 'vitest';
import {
  modelContextWindow,
  DEFAULT_CONTEXT_WINDOW,
  MODEL_CATALOG,
  findModelCatalogEntry,
  modelToolsSupport,
  modelOptionLabel,
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

  // É-3: a stored per-model window (auto-detected/user-set) rescues local models.
  it('uses the stored window for an unknown model instead of the default', () => {
    expect(modelContextWindow('openai-compatible', 'local-gemma', 8192)).toBe(8192);
    expect(modelContextWindow('ollama', 'llama-local', 16384)).toBe(16384);
  });

  it('the catalogued window always wins over a stored value', () => {
    // A catalogued model must NOT be overridden by a stale stored window.
    expect(modelContextWindow('anthropic', 'claude-opus-4-8', 8192)).toBe(200_000);
  });

  it('ignores a non-positive/invalid stored window and falls back to the default', () => {
    expect(modelContextWindow('openai-compatible', 'x', 0)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelContextWindow('openai-compatible', 'x', -5)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelContextWindow('openai-compatible', 'x', null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelContextWindow('openai-compatible', 'x', Number.NaN)).toBe(DEFAULT_CONTEXT_WINDOW);
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

// ─── modelToolsSupport / modelOptionLabel (tools-capability badge, 2026-07) ──

describe('modelToolsSupport', () => {
  it('is "yes" for a real tools:true catalog entry (moonshot/kimi-k2.6)', () => {
    expect(modelToolsSupport('moonshot', 'kimi-k2.6')).toBe('yes');
  });

  it('is "unknown" for a custom/uncatalogued id (never a hard "no")', () => {
    expect(modelToolsSupport('ollama', 'llama3.2')).toBe('unknown');
    expect(modelToolsSupport('openrouter', 'some/never-added')).toBe('unknown');
  });

  it('is "no" for a tools:false catalog entry', () => {
    // No catalogued model is tools:false today (deliberate curation — MiniMax/
    // Moonshot/GLM etc. all support tools, just not a FORCED tool_choice). The
    // mechanism must still work when one is added, so exercise it with a
    // throwaway fixture provider rather than skipping the branch.
    MODEL_CATALOG['__fixture_no_tools__'] = [
      {
        modelId: 'fixture-no-tools',
        label: 'Fixture (no tools)',
        capabilities: { tools: false, forcedToolChoice: false },
      },
    ];
    try {
      expect(modelToolsSupport('__fixture_no_tools__', 'fixture-no-tools')).toBe('no');
    } finally {
      delete MODEL_CATALOG['__fixture_no_tools__'];
    }
  });
});

describe('modelOptionLabel', () => {
  it('returns the plain label for a tools:true entry', () => {
    const entry = findModelCatalogEntry('moonshot', 'kimi-k2.6');
    expect(entry).toBeDefined();
    expect(modelOptionLabel(entry!)).toBe('Kimi K2.6');
  });

  it('appends "(no tools)" for a tools:false entry', () => {
    const fixture = {
      modelId: 'fixture-no-tools',
      label: 'Fixture Model',
      capabilities: { tools: false, forcedToolChoice: false },
    };
    expect(modelOptionLabel(fixture)).toBe('Fixture Model (no tools)');
  });
});
