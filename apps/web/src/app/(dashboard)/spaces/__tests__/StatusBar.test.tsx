// StatusBar.test.tsx — la barre du bas dit la preuve, les modèles, les agents,
// les jetons et leur part de cache, le coût, la durée, les envois en attente ;
// et un coût partiel se dit « partial », un coût inconnu « n/a ».

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusBar from '../StatusBar.tsx';
import type { SpaceCostView } from '@/lib/space-cost.ts';

const cost: SpaceCostView = {
  byAgent: [
    {
      agentId: 'a',
      agentName: 'Alfred',
      models: ['claude-opus-5'],
      calls: 7,
      inputTokens: 148_200,
      outputTokens: 4_100,
      cachedTokens: 96_000,
      cacheCreationTokens: 18_000,
      costUsd: 0.71,
      unpricedCalls: 0,
    },
    {
      agentId: 'b',
      agentName: 'Analyste',
      models: ['gpt-5'],
      calls: 3,
      inputTokens: 96_400,
      outputTokens: 2_200,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.38,
      unpricedCalls: 1,
    },
  ],
  totals: {
    calls: 10,
    inputTokens: 244_600,
    outputTokens: 6_300,
    cachedTokens: 96_000,
    cacheCreationTokens: 18_000,
    costUsd: 1.09,
    unpricedCalls: 1,
    llmDurationMs: 312_000,
    durationMs: 18 * 60_000 + 4_000,
    humanWaitMs: 192_000,
    proofMs: 401_000,
  },
};

describe('StatusBar', () => {
  const html = renderToStaticMarkup(
    <StatusBar
      cost={cost}
      proofVerdict="green"
      proofSequences={2}
      pendingDeliveries={1}
      live={false}
    />,
  );

  it('dit la preuve, les modèles, les agents', () => {
    expect(html).toContain('proof green');
    expect(html).toContain('claude-opus-5, gpt-5');
    expect(html).toContain('2 agents');
  });

  it('dit les jetons avec la part de cache, le coût avec « partial » quand un appel n’a pas de prix, la durée, l’envoi en attente', () => {
    expect(html).toContain('250,900 tokens · 39 % cached');
    expect(html).toContain('$1.09 · partial');
    expect(html).toContain('18 min 04');
    expect(html).toContain('1 delivery pending');
  });

  it('sans preuve, sans coût connu : « no proof », « n/a » — jamais un 0 qui voudrait dire gratuit', () => {
    const empty = renderToStaticMarkup(
      <StatusBar
        cost={{
          byAgent: [],
          totals: {
            ...cost.totals,
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            costUsd: null,
            unpricedCalls: 0,
          },
        }}
        proofVerdict={null}
        proofSequences={0}
        pendingDeliveries={0}
        live={true}
      />,
    );
    expect(empty).toContain('no proof');
    expect(empty).toContain('n/a');
    expect(empty).toContain('running…');
    expect(empty).not.toContain('$0');
    expect(empty).not.toContain('cached');
  });
});
