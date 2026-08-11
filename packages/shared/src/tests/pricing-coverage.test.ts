import { describe, it, expect } from 'vitest';
import { MODEL_CATALOG, estimateModelCostUsd } from '../model-catalog.js';

/**
 * Guard 1e (the dollar cost cap in apps/runner/src/job/execute.ts) can only fire
 * on a call whose cost is non-zero. OpenRouter self-reports one; every other
 * provider relies on `estimateModelCostUsd`, which returns 0 — not an error —
 * for a model with no `pricing` entry. A model added without a rate therefore
 * disables the cap for itself, silently, and nothing anywhere says so.
 *
 * On 2026-08-11 that was 36 of 51 catalogued models: the confidence card claimed
 * the cap "never fires outside OpenRouter", which was already false (the
 * token-derived fallback had landed with Fix #21), while the real hole — most of
 * the catalog carrying no rate — went unnamed. 34 rates were filled from
 * OpenRouter's live `/api/v1/models`; these tests exist so the remaining two
 * stay the only two.
 */

const UNPRICED_ON_PURPOSE = new Set([
  // Groq resells Llama on its own hardware at its own rate; the
  // `meta-llama/llama-3.3-70b-instruct` listing is a different seller.
  'groq/llama-3.3-70b-versatile',
  // A moving alias: OpenRouter lists `mistral-large` at 2/6 and
  // `mistral-large-2512` at 0.5/1.5. No honest rate for the alias itself.
  'mistral/mistral-large-latest',
]);

const allModels = Object.entries(MODEL_CATALOG).flatMap(([provider, entries]) =>
  entries.map((e) => ({ provider, key: `${provider}/${e.modelId}`, entry: e })),
);

describe('catalogue de modèles — couverture des prix', () => {
  it('the catalog is not empty (guards against a vacuous pass below)', () => {
    expect(allModels.length).toBeGreaterThan(40);
  });

  it('every model carries a rate, except the ones named above', () => {
    const missing = allModels.filter((m) => !m.entry.pricing).map((m) => m.key);
    expect(missing.sort()).toEqual([...UNPRICED_ON_PURPOSE].sort());
  });

  it('the exemption list never covers for a model that IS priced', () => {
    // Forces the list to SHRINK: fill a rate and the stale entry fails here.
    const stale = allModels.filter((m) => m.entry.pricing && UNPRICED_ON_PURPOSE.has(m.key));
    expect(stale.map((m) => m.key)).toEqual([]);
  });

  it('the exemption list names no model that left the catalog', () => {
    const known = new Set(allModels.map((m) => m.key));
    expect([...UNPRICED_ON_PURPOSE].filter((k) => !known.has(k))).toEqual([]);
  });

  it('no rate is zero, negative or absurd — a 0 would re-open the hole quietly', () => {
    for (const { key, entry } of allModels) {
      if (!entry.pricing) continue;
      const { inputPerMillionUsd: i, outputPerMillionUsd: o } = entry.pricing;
      expect(Number.isFinite(i) && i > 0, `${key} input`).toBe(true);
      expect(Number.isFinite(o) && o > 0, `${key} output`).toBe(true);
      // Nothing on the market bills over $1000/M; a unit slip (per-token
      // instead of per-million) lands three orders of magnitude out.
      expect(i, `${key} input`).toBeLessThan(1000);
      expect(o, `${key} output`).toBeLessThan(1000);
    }
  });

  it('output is never cheaper than input — the classic swapped-pair typo', () => {
    const swapped = allModels
      .filter(
        (m) =>
          m.entry.pricing &&
          m.entry.pricing.outputPerMillionUsd < m.entry.pricing.inputPerMillionUsd,
      )
      .map((m) => m.key);
    expect(swapped).toEqual([]);
  });

  it('a priced model yields a cost the cap can actually see', () => {
    // The real point of the rates: a job on a native provider must accrue
    // dollars. 1M in + 1M out on Sonnet 4.6 (3/15) is $18, not $0.
    expect(
      estimateModelCostUsd('anthropic', 'claude-sonnet-4-6', 1_000_000, 1_000_000),
    ).toBeCloseTo(18, 6);
    // And a typical turn is a real, non-zero number rather than a rounding hole.
    const turn = estimateModelCostUsd('minimax', 'MiniMax-M3', 40_000, 2_000);
    expect(turn).toBeGreaterThan(0);
    expect(turn).toBeCloseTo((40_000 / 1e6) * 0.3 + (2_000 / 1e6) * 1.2, 9);
  });

  it('an unpriced model still returns 0 — the documented backstop, stated not assumed', () => {
    expect(estimateModelCostUsd('groq', 'llama-3.3-70b-versatile', 1_000_000, 1_000_000)).toBe(0);
  });
});
