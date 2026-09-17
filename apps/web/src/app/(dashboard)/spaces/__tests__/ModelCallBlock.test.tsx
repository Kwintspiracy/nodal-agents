// ModelCallBlock.test.tsx — l'appel de modèle d'un tour, sur une ligne (#135).
//
// Ce qui compte ici n'est pas qu'une ligne existe, c'est ce qu'elle DIT et ce
// qu'elle tait : une valeur absente ne se dessine pas, et un tour DÉDUIT (celui
// dont on ne sait pas quel appel il désigne) n'a pas de bloc du tout.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ModelCallBlock from '../ModelCallBlock.tsx';
import type { TurnUsage } from '@/lib/conversation-feed.ts';

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  inputTokens: 4120,
  outputTokens: 380,
  cachedTokens: 3900,
  cacheCreationTokens: 0,
  costUsd: 0.011,
  durationMs: 6200,
  calls: 1,
  ...over,
});

describe('ModelCallBlock', () => {
  it('dit le modèle, ses jetons, sa durée et son coût', () => {
    const html = renderToStaticMarkup(<ModelCallBlock model="z-ai/glm-5.3" usage={usage()} />);
    expect(html).toContain('z-ai/glm-5.3');
    expect(html).toContain('4,120 in · 380 out · 3,900 cached');
    expect(html).toContain('6.2 s · $0.01');
    // La couleur porte la différence : le modèle d'un côté, les nombres de
    // l'autre — même police, même taille.
    expect(html).toMatch(/class="[^"]*text-feed-model[^"]*"[^>]*>z-ai\/glm-5\.3</);
    expect(html).toContain('text-feed-metric');
    expect(html).not.toMatch(/text-\[\d/);
  });

  it('une valeur absente n’est pas dessinée : ni « 0 cached », ni « $0 »', () => {
    const html = renderToStaticMarkup(
      <ModelCallBlock
        model="claude-opus-5"
        usage={usage({ cachedTokens: 0, costUsd: null, durationMs: 0 })}
      />,
    );
    expect(html).toContain('4,120 in · 380 out');
    expect(html).not.toContain('cached');
    expect(html).not.toContain('$');
    expect(html).not.toContain(' s<');
    expect(html).not.toContain('n/a');
  });

  it('un tour déduit (usage null) n’a AUCUN bloc', () => {
    expect(renderToStaticMarkup(<ModelCallBlock model="claude-opus-5" usage={null} />)).toBe('');
  });

  it('un usage qui ne dit rien du tout ne vaut pas un cadre vide', () => {
    const html = renderToStaticMarkup(
      <ModelCallBlock
        model={null}
        usage={usage({
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: null,
          durationMs: 0,
        })}
      />,
    );
    expect(html).toBe('');
  });
});
