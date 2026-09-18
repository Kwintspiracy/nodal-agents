// RunSummaryRow.test.tsx — la ligne qui résume un run, et ce que le clic ouvre
// (#135, #132).
//
// Deux niveaux de lecture, comme pour `ToolBlock` :
//   — `renderToStaticMarkup` pour ce que la ligne DIT sans navigateur ;
//   — jsdom + `createRoot`/`act` pour ce que le CLIC change, parce que la
//     promesse de #132 est exactement là : replié, le travail n'est PAS dans la
//     page ; un clic le met.
//
// La preuve que la ligne ne MENT pas est dans les comptes : ils viennent du
// modèle (`conversation-thread.ts`), et ce fichier vérifie qu'ils se lisent au
// mot près, singulier compris, et qu'un zéro ne se dessine jamais.

import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import RunSummaryRow, { runSummaryParts } from '../RunSummaryRow.tsx';
import type { RunSummary } from '@/lib/conversation-feed.ts';

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  tools: 3,
  delegations: 1,
  modelCalls: 2,
  durationMs: 12_000,
  costUsd: 0.04,
  ...over,
});

const WORK = 'the tool block of this run';

function markup(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

async function mount(node: React.ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

async function clickRow(container: HTMLDivElement): Promise<void> {
  const row = container.querySelector<HTMLButtonElement>('[data-testid="run-summary-j1"]');
  if (!row) throw new Error('la ligne de résumé n’a pas de tête cliquable');
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('runSummaryParts @cap:suivre-execution/ecran', () => {
  it('dit le run entier, dans l’ordre du tableau', () => {
    expect(runSummaryParts(summary()).join(' · ')).toBe(
      '3 tools · 1 delegation · 2 model calls · 12 s · $0.04',
    );
  });

  it('accorde le singulier', () => {
    expect(
      runSummaryParts(summary({ tools: 1, delegations: 1, modelCalls: 1 })).slice(0, 3),
    ).toEqual(['1 tool', '1 delegation', '1 model call']);
  });

  it('ne dessine RIEN de ce qui vaut zéro — jamais « 0 tools »', () => {
    const parts = runSummaryParts(summary({ tools: 0, delegations: 0 }));
    expect(parts.some((p) => p.includes('tool'))).toBe(false);
    expect(parts.some((p) => p.includes('delegation'))).toBe(false);
    expect(parts).toEqual(['2 model calls', '12 s', '$0.04']);
  });

  it('ne dessine ni « $0 » ni tiret quand le coût et la durée manquent', () => {
    const parts = runSummaryParts(summary({ durationMs: null, costUsd: null }));
    expect(parts.join(' · ')).toBe('3 tools · 1 delegation · 2 model calls');
    expect(runSummaryParts(summary({ costUsd: 0 })).some((p) => p.startsWith('$'))).toBe(false);
  });
});

describe('RunSummaryRow @cap:suivre-execution/ecran', () => {
  it('replié, le travail n’est PAS dans la page', () => {
    const html = markup(
      <RunSummaryRow jobId="j1" summary={summary()}>
        <p>{WORK}</p>
      </RunSummaryRow>,
    );
    expect(html).toContain('3 tools · 1 delegation · 2 model calls');
    expect(html).toContain('Show the work');
    expect(html).not.toContain(WORK);
    expect(html).toContain('aria-expanded="false"');
  });

  it('un clic met le travail dans la page, et la ligne change de mot', async () => {
    const container = await mount(
      <RunSummaryRow jobId="j1" summary={summary()}>
        <p>{WORK}</p>
      </RunSummaryRow>,
    );
    expect(container.textContent).not.toContain(WORK);
    await clickRow(container);
    expect(container.textContent).toContain(WORK);
    expect(container.textContent).toContain('Hide the work');
    expect(
      container.querySelector('[data-testid="run-summary-j1"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('la densité « unfolded » l’ouvre DÈS le premier rendu', () => {
    const html = markup(
      <RunSummaryRow jobId="j1" summary={summary()} defaultOpen>
        <p>{WORK}</p>
      </RunSummaryRow>,
    );
    expect(html).toContain(WORK);
    expect(html).toContain('Hide the work');
    expect(html).toContain('aria-expanded="true"');
  });

  it('un run dont on ne sait RIEN garde sa ligne, sans nombre inventé', () => {
    const html = markup(
      <RunSummaryRow
        jobId="j1"
        summary={{ tools: 0, delegations: 0, modelCalls: 0, durationMs: null, costUsd: null }}
      >
        <p>{WORK}</p>
      </RunSummaryRow>,
    );
    // L'assertion porte sur la travée des métriques, pas sur le HTML entier :
    // les chemins SVG du chevron contiennent des chiffres, et « 0 » y tombe par
    // accident. Aucune travée = aucun nombre dessiné.
    expect(html).toContain('Show the work');
    expect(html).not.toContain('text-feed-metric');
    expect(
      runSummaryParts({
        tools: 0,
        delegations: 0,
        modelCalls: 0,
        durationMs: null,
        costUsd: null,
      }),
    ).toEqual([]);
  });
});
