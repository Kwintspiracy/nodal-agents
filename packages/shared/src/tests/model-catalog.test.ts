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
  modelCanSeeImages,
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

// ─── Google native catalog refresh (2026-07-12: 2.0-flash/2.5-pro dropped,
// 3.x family added) ────────────────────────────────────────────────────────

describe('google native catalog', () => {
  it('no longer lists the dead/removed 2.x models', () => {
    expect(findModelCatalogEntry('google', 'gemini-2.0-flash')).toBeUndefined();
    expect(findModelCatalogEntry('google', 'gemini-2.5-pro')).toBeUndefined();
  });

  it('gemini-3.5-flash and gemini-3.1-pro-preview are reasoning + vision + forcedToolChoice:false', () => {
    for (const modelId of ['gemini-3.5-flash', 'gemini-3.1-pro-preview']) {
      const entry = findModelCatalogEntry('google', modelId);
      expect(entry, modelId).toBeDefined();
      expect(entry?.capabilities.reasoning, modelId).toBe(true);
      expect(entry?.capabilities.tools, modelId).toBe(true);
      expect(entry?.capabilities.forcedToolChoice, modelId).toBe(false);
      expect(entry?.capabilities.vision, modelId).toBe(true);
      expect(entry?.contextWindow, modelId).toBe(1_048_576);
    }
  });
});

// ─── OpenRouter google reasoning flags (2026-07-12) ───────────────────────────

describe('openrouter google reasoning flags', () => {
  it('the three Gemini thinking models are flagged reasoning:true', () => {
    for (const modelId of [
      'google/gemini-3.1-flash-lite-preview',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.5-flash',
    ]) {
      const entry = findModelCatalogEntry('openrouter', modelId);
      expect(entry, modelId).toBeDefined();
      expect(entry?.capabilities.reasoning, modelId).toBe(true);
      // Unlike the M-series/Kimi/GLM reasoning entries, these keep a forced
      // tool_choice — no evidence Gemini's OpenRouter routes reject it.
      expect(entry?.capabilities.forcedToolChoice, modelId).toBe(true);
    }
  });

  it('gemma (non-thinking) is left untouched', () => {
    const entry = findModelCatalogEntry('openrouter', 'google/gemma-4-31b-it');
    expect(entry).toBeDefined();
    expect(entry?.capabilities.reasoning).toBeUndefined();
  });
});

// ─── Reasoning control (per-agent effort brick, 2026-07-20) ───────────────────

describe('reasoningControl coherence', () => {
  it('every reasoning:true entry declares a coherent reasoningControl', () => {
    for (const [provider, entries] of Object.entries(MODEL_CATALOG)) {
      for (const e of entries) {
        if (e.capabilities.reasoning !== true) continue;
        const key = `${provider}/${e.modelId}`;
        const rc = e.capabilities.reasoningControl;
        expect(rc, key).toBeDefined();
        if (rc?.kind === 'effort' || rc?.kind === 'adaptive-effort') {
          expect(rc.levels?.length, key).toBeGreaterThan(0);
          for (const level of rc.levels ?? []) {
            expect(['low', 'medium', 'high', 'max'], key).toContain(level);
          }
        }
        if (rc?.kind === 'budget') {
          expect(Object.keys(rc.budgets ?? {}).length, key).toBeGreaterThan(0);
          for (const budget of Object.values(rc.budgets ?? {})) {
            expect(budget, key).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('native Anthropic and OpenAI entries are now reasoning-capable (the core gain)', () => {
    for (const [provider, modelId, kind] of [
      ['anthropic', 'claude-opus-4-8', 'adaptive-effort'],
      ['anthropic', 'claude-sonnet-4-6', 'adaptive-effort'],
      ['anthropic', 'claude-haiku-4-5-20251001', 'budget'],
      ['openai', 'gpt-5', 'effort'],
      ['openai', 'gpt-5-mini', 'effort'],
    ] as const) {
      const entry = findModelCatalogEntry(provider, modelId);
      expect(entry?.capabilities.reasoning, modelId).toBe(true);
      expect(entry?.capabilities.reasoningControl?.kind, modelId).toBe(kind);
    }
  });

  it('OpenRouter Claude routes have control WITHOUT the always-on reasoning flag', () => {
    const entry = findModelCatalogEntry('openrouter', 'anthropic/claude-opus-4.8');
    expect(entry?.capabilities.reasoning).toBeUndefined();
    expect(entry?.capabilities.reasoningControl?.kind).toBe('effort');
  });

  it('Grok 4.5 and Qwen 3.7 entries (2026-07-20) match their verified capabilities', () => {
    // Grok 4.5: always reasons (rejects effort 'none' — Hermes verified live),
    // levels low/medium/high only, multimodal.
    const grok = findModelCatalogEntry('openrouter', 'x-ai/grok-4.5');
    expect(grok?.capabilities.reasoning).toBe(true);
    expect(grok?.capabilities.reasoningControl).toEqual({
      kind: 'effort',
      levels: ['low', 'medium', 'high'],
      mandatory: true,
    });
    expect(grok?.capabilities.vision).toBe(true);
    expect(grok?.contextWindow).toBe(500_000);
    // Qwen 3.7: hybrid thinkers — control WITHOUT the always-on flag (Auto
    // keeps provider default), max is text-only, plus is multimodal.
    const qmax = findModelCatalogEntry('openrouter', 'qwen/qwen3.7-max');
    expect(qmax?.capabilities.reasoning).toBeUndefined();
    expect(qmax?.capabilities.reasoningControl?.kind).toBe('effort');
    expect(qmax?.capabilities.vision).toBe(false);
    const qplus = findModelCatalogEntry('openrouter', 'qwen/qwen3.7-plus');
    expect(qplus?.capabilities.vision).toBe(true);
  });

  it('known single-level and mandatory models are encoded (K3 max-only, K2-line onoff)', () => {
    const k3 = findModelCatalogEntry('moonshot', 'kimi-k3');
    expect(k3?.capabilities.reasoningControl).toEqual({
      kind: 'effort',
      levels: ['max'],
      mandatory: true,
    });
    const k26 = findModelCatalogEntry('moonshot', 'kimi-k2.6');
    expect(k26?.capabilities.reasoningControl).toEqual({ kind: 'onoff', mandatory: true });
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

describe('GLM 5.3 Flash', () => {
  // Every value below was read off OpenRouter's /api/v1/models on 2026-08-28
  // (z-ai/glm-5.3-flash). They are asserted rather than eyeballed because a
  // wrong context window silently mis-sizes runtime compaction and wrong
  // pricing mis-reports every job's cost.
  const flash = findModelCatalogEntry('openrouter', 'z-ai/glm-5.3-flash');

  it('is catalogued under the openrouter provider', () => {
    expect(flash).toBeDefined();
    expect(flash?.label).toBe('GLM 5.3 Flash');
  });

  it('carries the upstream context window (1.31M — LARGER than full 5.3)', () => {
    expect(modelContextWindow('openrouter', 'z-ai/glm-5.3-flash')).toBe(1_310_720);
    // Guards the copy-paste failure mode: reusing 5.3's window for its sibling.
    expect(modelContextWindow('openrouter', 'z-ai/glm-5.3')).toBe(1_048_576);
  });

  it('carries the upstream pricing', () => {
    // Le prix de lecture du cache (P4a, lu sur /api/v1/models le 2026-09-06)
    // fait partie du contrat : sans lui, le coût d'un tour qui relit son
    // contexte serait compté au prix plein.
    expect(flash?.pricing).toEqual({
      inputPerMillionUsd: 0.075,
      outputPerMillionUsd: 0.25,
      cacheReadPerMillionUsd: 0.015,
    });
  });

  it('supports tools, and reasoning WITHOUT the family mandatory flag', () => {
    expect(flash?.capabilities.tools).toBe(true);
    expect(flash?.capabilities.forcedToolChoice).toBe(false);
    expect(flash?.capabilities.reasoning).toBe(true);
    // 5.2/5.3 are mandatory:true (they always think). Nothing upstream says
    // Flash does, so 'off' must remain offered — no guessed mandatory flag.
    expect(flash?.capabilities.reasoningControl?.mandatory).toBeUndefined();
    expect(flash?.capabilities.reasoningControl?.levels).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('is vision-capable, while the full 5.3 is text-only', () => {
    expect(modelCanSeeImages('z-ai/glm-5.3-flash')).toBe(true);
    expect(modelCanSeeImages('z-ai/glm-5.3')).toBe(false);
  });
});

describe('OpenRouter catch-up of 2026-09-22 (thirteen models)', () => {
  // Every value below was read off OpenRouter's /api/v1/models (and
  // /models/<id>/endpoints for supported_parameters) on 2026-09-22. Asserted
  // rather than eyeballed, for the same two reasons as GLM 5.3 Flash above:
  // a wrong window mis-sizes compaction, a wrong price mis-reports every job.
  const entry = (id: string) => findModelCatalogEntry('openrouter', id);

  it('the thirteen ids are catalogued under the openrouter provider', () => {
    for (const id of [
      'xiaomi/mimo-v2.6-flash',
      'xiaomi/mimo-v2.6-pro',
      'xiaomi/mimo-v2.6-pro-ultraspeed',
      'z-ai/glm-5.3-flashx',
      'x-ai/grok-4.6',
      'x-ai/grok-4.7',
      'deepseek/deepseek-v4-pro-0813',
      'deepseek/deepseek-v4.1-flash',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-sol-pro',
      'openai/gpt-6-astra',
      'openai/gpt-6-astra-pro',
    ]) {
      expect(entry(id), id).toBeDefined();
      expect(entry(id)?.capabilities.tools, id).toBe(true);
    }
  });

  it('Xiaomi MiMo V2.6: 1.05M window, upstream pricing, on/off thinking, forced tool_choice', () => {
    for (const id of [
      'xiaomi/mimo-v2.6-flash',
      'xiaomi/mimo-v2.6-pro',
      'xiaomi/mimo-v2.6-pro-ultraspeed',
    ]) {
      expect(modelContextWindow('openrouter', id), id).toBe(1_048_576);
    }
    expect(entry('xiaomi/mimo-v2.6-flash')?.pricing).toEqual({
      inputPerMillionUsd: 0.14,
      outputPerMillionUsd: 0.28,
      cacheReadPerMillionUsd: 0.0028,
    });
    expect(entry('xiaomi/mimo-v2.6-pro')?.pricing).toEqual({
      inputPerMillionUsd: 0.435,
      outputPerMillionUsd: 0.87,
      cacheReadPerMillionUsd: 0.0036,
    });
    // UltraSpeed is the same checkpoint at 10x the price — the one figure a
    // copy-paste of Pro would get wrong.
    expect(entry('xiaomi/mimo-v2.6-pro-ultraspeed')?.pricing).toEqual({
      inputPerMillionUsd: 4.35,
      outputPerMillionUsd: 8.7,
      cacheReadPerMillionUsd: 0.036,
    });
    for (const id of [
      'xiaomi/mimo-v2.6-flash',
      'xiaomi/mimo-v2.6-pro',
      'xiaomi/mimo-v2.6-pro-ultraspeed',
    ]) {
      // Upstream's `reasoning` object is {mandatory:false} and nothing else:
      // no effort scale exists, thinking is on or off. No always-on flag.
      expect(entry(id)?.capabilities.reasoning, id).toBeUndefined();
      expect(entry(id)?.capabilities.reasoningControl, id).toEqual({ kind: 'onoff' });
      // supports_tool_choice.required:true on every MiMo endpoint.
      expect(entry(id)?.capabilities.forcedToolChoice, id).toBe(true);
      expect(modelCanSeeImages(id), id).toBe(true);
    }
  });

  it('GLM 5.3 FlashX: the full 5.3 reasoning contract, its own price and window', () => {
    const x = entry('z-ai/glm-5.3-flashx');
    expect(x?.pricing).toEqual({
      inputPerMillionUsd: 0.37,
      outputPerMillionUsd: 1.25,
      cacheReadPerMillionUsd: 0.075,
    });
    // 1.05M — NOT Flash's 1.31M: the copy-paste failure mode, guarded.
    expect(modelContextWindow('openrouter', 'z-ai/glm-5.3-flashx')).toBe(1_048_576);
    expect(x?.capabilities.reasoning).toBe(true);
    // Upstream `reasoning`: mandatory:true, supported_efforts max/high/low.
    expect(x?.capabilities.reasoningControl).toEqual({
      kind: 'effort',
      levels: ['low', 'high', 'max'],
      mandatory: true,
    });
    expect(x?.capabilities.forcedToolChoice).toBe(false);
    expect(modelCanSeeImages('z-ai/glm-5.3-flashx')).toBe(true);
  });

  it('Grok 4.6 and 4.7: mandatory reasoning WITH max (xhigh upstream), 4.7 is 20% cheaper', () => {
    for (const id of ['x-ai/grok-4.6', 'x-ai/grok-4.7']) {
      expect(modelContextWindow('openrouter', id), id).toBe(500_000);
      expect(entry(id)?.capabilities.reasoning, id).toBe(true);
      // Upstream `reasoning`: mandatory:true, supported_efforts
      // xhigh/high/medium/low — one level more than 4.5, which stops at high.
      expect(entry(id)?.capabilities.reasoningControl, id).toEqual({
        kind: 'effort',
        levels: ['low', 'medium', 'high', 'max'],
        mandatory: true,
      });
      expect(entry('x-ai/grok-4.5')?.capabilities.reasoningControl?.levels).toEqual([
        'low',
        'medium',
        'high',
      ]);
      expect(modelCanSeeImages(id), id).toBe(true);
    }
    expect(entry('x-ai/grok-4.6')?.pricing).toEqual({
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 6,
      cacheReadPerMillionUsd: 0.5,
    });
    expect(entry('x-ai/grok-4.7')?.pricing).toEqual({
      inputPerMillionUsd: 1.6,
      outputPerMillionUsd: 4.8,
      cacheReadPerMillionUsd: 0.4,
    });
  });

  it('DeepSeek V4 Pro 0813 and V4.1 Flash: providerOrder, pricing, three levels, and only V4.1 Flash sees images', () => {
    for (const id of ['deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4.1-flash']) {
      expect(entry(id)?.providerOrder, id).toEqual(['deepseek']);
      expect(entry(id)?.capabilities.reasoning, id).toBe(true);
      expect(modelContextWindow('openrouter', id), id).toBe(1_048_576);
      // Upstream `reasoning`: supported_efforts max/high/low, no medium.
      expect(entry(id)?.capabilities.reasoningControl?.levels, id).toEqual(['low', 'high', 'max']);
      expect(entry(id)?.capabilities.reasoningControl?.mandatory, id).toBeUndefined();
    }
    // supports_tool_choice.required is true on DeepSeek's V4 Pro endpoint and
    // false on every V4.1 Flash endpoint.
    expect(entry('deepseek/deepseek-v4-pro-0813')?.capabilities.forcedToolChoice).toBe(true);
    expect(entry('deepseek/deepseek-v4.1-flash')?.capabilities.forcedToolChoice).toBe(false);
    expect(entry('deepseek/deepseek-v4-pro-0813')?.pricing).toEqual({
      inputPerMillionUsd: 0.66,
      outputPerMillionUsd: 1.98,
      cacheReadPerMillionUsd: 0.022,
    });
    expect(entry('deepseek/deepseek-v4.1-flash')?.pricing).toEqual({
      inputPerMillionUsd: 0.15,
      outputPerMillionUsd: 0.6,
      cacheReadPerMillionUsd: 0.003,
    });
    expect(modelCanSeeImages('deepseek/deepseek-v4.1-flash')).toBe(true);
    expect(modelCanSeeImages('deepseek/deepseek-v4-pro-0813')).toBe(false);
    expect(modelCanSeeImages('deepseek/deepseek-v4-flash-0731')).toBe(false);
  });

  it('GPT-5.6 Sol/Terra and GPT-6 Astra: 1.05M window, upstream pricing, vision', () => {
    const prix = {
      'openai/gpt-5.6-terra': [2, 12, 0.2, 2.5],
      'openai/gpt-5.6-sol': [2, 10, 0.2, 2.5],
      'openai/gpt-5.6-sol-pro': [2, 10, 0.2, 2.5],
      'openai/gpt-6-astra': [10, 50, 1, 12.5],
      'openai/gpt-6-astra-pro': [10, 50, 1, 12.5],
    } as const;
    for (const [id, [i, o, cr, cw]] of Object.entries(prix)) {
      expect(entry(id)?.pricing, id).toEqual({
        inputPerMillionUsd: i,
        outputPerMillionUsd: o,
        cacheReadPerMillionUsd: cr,
        cacheWritePerMillionUsd: cw,
      });
      expect(modelContextWindow('openrouter', id), id).toBe(1_050_000);
      expect(entry(id)?.capabilities.forcedToolChoice, id).toBe(true);
      expect(entry(id)?.capabilities.reasoningControl?.levels, id).toEqual([
        'low',
        'medium',
        'high',
        'max',
      ]);
      // Upstream `reasoning`: Astra and Astra Pro are mandatory:true (no
      // 'none' in supported_efforts); the 5.6 models list 'none', so Off stays.
      expect(entry(id)?.capabilities.reasoningControl?.mandatory, id).toBe(
        id.startsWith('openai/gpt-6-astra') ? true : undefined,
      );
      expect(modelCanSeeImages(id), id).toBe(true);
    }
  });
});
