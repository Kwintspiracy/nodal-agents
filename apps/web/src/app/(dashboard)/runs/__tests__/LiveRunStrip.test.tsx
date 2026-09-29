// LiveRunStrip.test.tsx — la bande qui montre le run pendant qu'il tourne (#444).
//
// Un run de deux heures qui ne montre rien se fait tuer à la main par
// inquiétude. La bande dit, pendant `processing` : le tour, ce que l'appel en
// cours produit, depuis quand rien n'est venu, et le budget consommé face aux
// plafonds du run (#442). Hors `processing`, rien : aucun état inventé.
//
// La progression vient de `agent_jobs.live_progress`, posée par le runner à
// partir du flux de l'appel (#484) — la même mesure que ses journaux.
//
// Mutations vérifiées :
//   - la garde `status === 'processing'` retirée → « hors processing, rien »
//     rougit ;
//   - l'âge du dernier morceau calculé depuis le DÉBUT de l'appel → « la bande
//     dit … » rougit.

import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import LiveRunStrip from '../LiveRunStrip.tsx';
import type { SpaceCostView } from '@/lib/space-cost.ts';
import { EMPTY_SPACE_COST } from '@/lib/space-cost.ts';

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const NOW = new Date('2026-09-28T10:41:03.000Z');

const cost = (over: Partial<SpaceCostView> = {}): SpaceCostView => ({
  ...EMPTY_SPACE_COST,
  totals: { ...EMPTY_SPACE_COST.totals, calls: 12, costUsd: 0.84, durationMs: 41 * 60_000 },
  runBudget: { maxRunCostUsd: 5, maxRunHours: 3 },
  ...over,
});

const ECRIT = {
  turn: 8,
  textChars: 2_340,
  reasoningChars: 0,
  toolInputChars: 0,
  toolName: null,
  callStartedAt: '2026-09-28T10:40:00.000Z',
  lastProgressAt: '2026-09-28T10:41:00.000Z',
};

async function render(props: Parameters<typeof LiveRunStrip>[0]): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<LiveRunStrip {...props} />);
  });
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('la bande du run en cours (#444) @cap:suivre-execution/ecran', () => {
  it('la bande dit le tour, ce qui s’écrit, le dernier morceau, et le budget face aux plafonds', async () => {
    const texte = await render({
      status: 'processing',
      liveProgress: ECRIT,
      cost: cost(),
      now: NOW,
    });
    expect(texte).toBe(
      'Turn 8 · writing · 2,340 characters · last output 3 s ago · 41 min / 3 h · $0.84 / $5.00',
    );
    expect(texte).not.toContain('—');
  });

  it('un outil en cours de remplissage, et un appel qui n’a encore rien rendu', async () => {
    expect(
      await render({
        status: 'processing',
        liveProgress: { ...ECRIT, textChars: 0, toolInputChars: 48_000, toolName: 'file_write' },
        cost: cost(),
        now: NOW,
      }),
    ).toContain('Turn 8 · filling file_write · 48,000 characters');
    act(() => root.unmount());
    container.remove();

    expect(
      await render({
        status: 'processing',
        liveProgress: { ...ECRIT, textChars: 0, lastProgressAt: null },
        cost: cost(),
        now: NOW,
      }),
    ).toContain('Turn 8 · waiting for the model · 1 min 03');
  });

  it('entre deux appels (un outil qui tourne), le budget seul, sans tour inventé', async () => {
    const texte = await render({
      status: 'processing',
      liveProgress: null,
      cost: cost(),
      now: NOW,
    });
    expect(texte).toBe('41 min / 3 h · $0.84 / $5.00');
  });

  it('sans plafond de run, le budget se dit sans « / »', async () => {
    const texte = await render({
      status: 'processing',
      liveProgress: null,
      cost: cost({ runBudget: { maxRunCostUsd: 0, maxRunHours: 0 } }),
      now: NOW,
    });
    expect(texte).toBe('41 min · $0.84');
  });

  it('hors processing, rien : ni une progression restée en base, ni le budget', async () => {
    for (const status of ['completed', 'cancelled', 'failed', 'awaiting_approval', null]) {
      const texte = await render({ status, liveProgress: ECRIT, cost: cost(), now: NOW });
      expect(texte, String(status)).toBe('');
      expect(container.querySelector('[data-testid="live-run-strip"]')).toBeNull();
      act(() => root.unmount());
      container.remove();
    }
    await render({ status: 'completed', liveProgress: null, cost: cost(), now: NOW });
  });
});
