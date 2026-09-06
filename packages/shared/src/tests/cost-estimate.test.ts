// cost-estimate.test.ts — le coût d'un appel au plus près du réel (P4, plan
// « De la maquette au produit ») : les jetons lus en cache au prix de lecture,
// les écrits au prix d'écriture, le reste au prix plein — et un modèle dont le
// cache n'a pas de prix est facturé plein, en le disant.

import { describe, it, expect } from 'vitest';
import {
  MODEL_CATALOG,
  estimateCallCostUsd,
  estimateModelCostUsd,
  hasCachePricing,
  findModelCatalogEntry,
} from '../model-catalog.js';

describe('estimateCallCostUsd — cache-aware', () => {
  it('Claude Opus 5 via OpenRouter : lecture au dixième, écriture à 1,25×, comparé au centime', () => {
    const p = findModelCatalogEntry('openrouter', 'anthropic/claude-opus-5')!.pricing!;
    expect(p).toMatchObject({ inputPerMillionUsd: 5, outputPerMillionUsd: 25 });
    // Les rapports publiés par le vendeur, vérifiés sur le catalogue lui-même.
    expect(p.cacheReadPerMillionUsd).toBeCloseTo(0.5, 9); // 1/10 du prix d'entrée
    expect(p.cacheWritePerMillionUsd).toBeCloseTo(6.25, 9); // 1,25×
    // 10 000 jetons d'entrée : 8 000 relus du cache, 1 000 écrits, 1 000 frais ; 500 en sortie.
    const cost = estimateCallCostUsd('openrouter', 'anthropic/claude-opus-5', {
      inputTokens: 10_000,
      outputTokens: 500,
      cachedTokens: 8_000,
      cacheCreationTokens: 1_000,
    });
    const expected =
      (1_000 / 1e6) * 5 + (8_000 / 1e6) * 0.5 + (1_000 / 1e6) * 6.25 + (500 / 1e6) * 25;
    expect(cost).toBeCloseTo(expected, 9); // 0,02775 $
    // Sans remise de cache le même appel vaudrait 0,0625 $ : l'écart est le sujet.
    const blind = estimateModelCostUsd('openrouter', 'anthropic/claude-opus-5', 10_000, 500);
    expect(blind).toBeCloseTo(0.0625, 9);
    expect(cost).toBeLessThan(blind);
  });

  it('un modèle sans prix de cache est facturé plein — une SURESTIMATION, dite par hasCachePricing', () => {
    // Le natif DeepSeek garde son prix vendeur et n'a pas de prix de cache ici.
    expect(hasCachePricing('deepseek', 'deepseek-reasoner')).toBe(false);
    const withCache = estimateCallCostUsd('deepseek', 'deepseek-reasoner', {
      inputTokens: 10_000,
      outputTokens: 0,
      cachedTokens: 9_000,
    });
    const blind = estimateModelCostUsd('deepseek', 'deepseek-reasoner', 10_000, 0);
    expect(withCache).toBeCloseTo(blind, 12);
    // Et un modèle qui EN a un le dit.
    expect(hasCachePricing('openrouter', 'anthropic/claude-opus-5')).toBe(true);
  });

  it('des compteurs incohérents ne produisent jamais un coût négatif ni un cache > entrée', () => {
    const cost = estimateCallCostUsd('openrouter', 'anthropic/claude-opus-5', {
      inputTokens: 1_000,
      outputTokens: 0,
      cachedTokens: 5_000, // plus que l'entrée : borné à l'entrée
      cacheCreationTokens: 5_000,
    });
    expect(cost).toBeCloseTo((1_000 / 1e6) * 0.5, 9); // tout en lecture, rien de frais, rien d'écrit
    expect(
      estimateCallCostUsd('openrouter', 'anthropic/claude-opus-5', {
        inputTokens: -5,
        outputTokens: NaN,
      }),
    ).toBe(0);
  });

  it('un modèle non tarifé rend 0 — le repli documenté, dit pas supposé', () => {
    expect(
      estimateCallCostUsd('groq', 'llama-3.3-70b-versatile', {
        inputTokens: 1e6,
        outputTokens: 1e6,
      }),
    ).toBe(0);
    expect(hasCachePricing('groq', 'llama-3.3-70b-versatile')).toBe(false);
  });

  it('estimateModelCostUsd = le même calcul sans cache (compatibilité)', () => {
    for (const [provider, entries] of Object.entries(MODEL_CATALOG)) {
      for (const e of entries) {
        if (!e.pricing) continue;
        expect(estimateModelCostUsd(provider, e.modelId, 1234, 56)).toBeCloseTo(
          estimateCallCostUsd(provider, e.modelId, { inputTokens: 1234, outputTokens: 56 }),
          12,
        );
      }
    }
  });
});

describe('catalogue — les prix de cache', () => {
  const all = Object.entries(MODEL_CATALOG).flatMap(([provider, entries]) =>
    entries.map((e) => ({ key: `${provider}/${e.modelId}`, p: e.pricing })),
  );

  it('un prix de lecture ne dépasse jamais le prix d’entrée — sinon le cache coûterait plus cher que le frais', () => {
    const wrong = all
      .filter(
        (m) =>
          m.p?.cacheReadPerMillionUsd !== undefined &&
          m.p.cacheReadPerMillionUsd > m.p.inputPerMillionUsd,
      )
      .map((m) => m.key);
    expect(wrong).toEqual([]);
  });

  it('les modèles SANS prix de cache sont nommés — la liste ne peut que rétrécir', () => {
    // Facturés plein sur leurs jetons de cache (surestimation). Natifs dont le
    // vendeur n'est pas passé par OpenRouter, variantes -fast sans fiche, et les
    // deux non tarifés de pricing-coverage.
    const missing = all
      .filter((m) => m.p && m.p.cacheReadPerMillionUsd === undefined)
      .map((m) => m.key)
      .sort();
    expect(missing).toEqual(
      [
        'deepseek/deepseek-chat',
        'deepseek/deepseek-reasoner',
        'minimax/MiniMax-M2',
        'openrouter/anthropic/claude-opus-5-fast',
        'openrouter/anthropic/claude-opus-4.7-fast',
        'openrouter/anthropic/claude-opus-4.8-fast',
        'openrouter/qwen/qwen3.8-max',
      ].sort(),
    );
  });

  it('les prix de cache sont positifs et finis', () => {
    for (const m of all) {
      if (!m.p) continue;
      for (const k of ['cacheReadPerMillionUsd', 'cacheWritePerMillionUsd'] as const) {
        const v = m.p[k];
        if (v === undefined) continue;
        expect(Number.isFinite(v) && v > 0, `${m.key} ${k}`).toBe(true);
      }
    }
  });
});
