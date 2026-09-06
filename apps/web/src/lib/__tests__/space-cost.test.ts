// space-cost.test.ts — l'agrégat de coût d'un espace, au centime : par agent,
// part de cache, appels sans prix comptés à part, attente humaine, temps de
// preuve, durée du travail.

import { describe, it, expect } from 'vitest';
import { aggregateSpaceCost } from '../space-cost.ts';

const t0 = new Date('2026-09-06T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

describe('aggregateSpaceCost', () => {
  it('agrège par agent et au total, le coût inconnu restant nul et compté', () => {
    const cost = aggregateSpaceCost({
      calls: [
        {
          agentId: 'a',
          agentName: 'Alfred',
          modelEffective: 'claude-opus-5',
          inputTokens: 10_000,
          outputTokens: 500,
          cachedTokens: 8_000,
          cacheCreationTokens: 1_000,
          costUsd: 0.02775,
          durationMs: 4_000,
        },
        {
          agentId: 'a',
          agentName: 'Alfred',
          modelEffective: 'claude-opus-5',
          inputTokens: 12_000,
          outputTokens: 300,
          cachedTokens: 11_000,
          cacheCreationTokens: 0,
          costUsd: 0.01,
          durationMs: 3_000,
        },
        {
          agentId: 'b',
          agentName: 'Analyste',
          modelEffective: 'gpt-5',
          inputTokens: 40_000,
          outputTokens: 2_000,
          cachedTokens: 0,
          cacheCreationTokens: null,
          costUsd: 0.07,
          durationMs: 31_000,
        },
        {
          agentId: 'b',
          agentName: 'Analyste',
          modelEffective: 'llama-3.3-70b-versatile',
          inputTokens: 5_000,
          outputTokens: 100,
          cachedTokens: null,
          cacheCreationTokens: null,
          costUsd: null,
          durationMs: 900,
        },
      ],
      approvals: [
        { requestedAt: at(1), resolvedAt: at(4) }, // 3 min d'attente
        { requestedAt: at(5), resolvedAt: null }, // pas encore tranchée : ne compte pas
      ],
      proofMs: 401_000,
      startedAt: t0,
      endedAt: at(18),
    });

    expect(
      cost.byAgent.map((a) => [a.agentName, a.calls, a.costUsd, a.unpricedCalls, a.models]),
    ).toEqual([
      ['Analyste', 2, 0.07, 1, ['gpt-5', 'llama-3.3-70b-versatile']], // le plus cher d'abord
      ['Alfred', 2, 0.03775, 0, ['claude-opus-5']],
    ]);
    // Le coût se compare au centime à part : une somme flottante n'est pas égale bit à bit.
    const { costUsd: totalCost, ...restTotals } = cost.totals;
    expect(restTotals).toEqual({
      calls: 4,
      inputTokens: 67_000,
      outputTokens: 2_900,
      cachedTokens: 19_000,
      cacheCreationTokens: 1_000,
      unpricedCalls: 1,
      llmDurationMs: 38_900,
      durationMs: 18 * 60_000,
      humanWaitMs: 3 * 60_000,
      proofMs: 401_000,
    });
    expect(totalCost).toBeCloseTo(0.10775, 9);
  });

  it('aucun appel : un coût null, pas 0 — et un job qui court mesure sa durée jusqu’à maintenant', () => {
    const cost = aggregateSpaceCost({
      calls: [],
      approvals: [],
      proofMs: 0,
      startedAt: new Date(Date.now() - 60_000),
      endedAt: null,
    });
    expect(cost.byAgent).toEqual([]);
    expect(cost.totals.costUsd).toBeNull();
    expect(cost.totals.calls).toBe(0);
    expect(cost.totals.durationMs).toBeGreaterThanOrEqual(60_000);
  });

  it('un appel sans agent connu se range sous « Unknown agent » plutôt que de disparaître', () => {
    const cost = aggregateSpaceCost({
      calls: [
        {
          agentId: null,
          agentName: null,
          modelEffective: 'm',
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.001,
          durationMs: 1,
        },
      ],
      approvals: [],
      proofMs: 0,
      startedAt: null,
      endedAt: null,
    });
    expect(cost.byAgent[0]?.agentName).toBe('Unknown agent');
    expect(cost.totals.durationMs).toBe(0);
  });
});
