// RunRow.test.tsx — la ligne d'un run, repliée puis dépliée (#134).
//
// Ce que ce fichier prouve, dans un vrai DOM (jsdom), sur le RENDU et sur
// l'ARGUMENT que l'action reçoit, jamais sur un nombre d'appels :
//
//   repliée  — les sept éléments sont là : agent, origine, titre, statut,
//              durée, coût, nombre d'appels ;
//   dépliée  — les appels paraissent DANS L'ORDRE où l'action les rend, outils
//              et modèles entrelacés, chacun dans son bloc ;
//   et surtout : RIEN n'est demandé tant que la ligne est repliée. C'est la
//              décision même de #134 — la page compte des runs, elle ne lit
//              pas leurs appels.
//
// Le moteur (`src/lib/__tests__/activity-runs-action.test.ts`) prouve la même
// promesse côté base. Un écran peut être vert devant un moteur débranché : les
// deux niveaux existent pour ça.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ActivityRunRow, RunCall } from '@/lib/actions.ts';
import RunRow from '../RunRow.tsx';

type CallsResult =
  | {
      ok: true;
      data: { items: RunCall[]; page: number; pageSize: number; hasMore: boolean; total: number };
    }
  | { ok: false; code: string; message: string };

const listRunCallsAction = vi.hoisted(() =>
  vi.fn(
    async (_raw: { jobId: string; page?: number; pageSize?: number }): Promise<CallsResult> => ({
      ok: true,
      data: { items: [], page: 1, pageSize: 50, hasMore: false, total: 0 },
    }),
  ),
);

vi.mock('@/lib/actions.ts', () => ({ listRunCallsAction }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

const RUN_ID = '22222222-2222-4222-8222-222222222222';

const run: ActivityRunRow = {
  id: RUN_ID,
  agentId: '33333333-3333-4333-8333-333333333333',
  agentName: 'Alfred',
  agentSlug: 'alfred',
  agentAvatarUrl: null,
  origin: { label: 'Telegram', detail: null },
  task: 'Poster le résumé de la veille dans le canal',
  status: 'completed',
  durationMs: 4200,
  costUsd: 0.0123,
  callCount: 3,
  createdAt: new Date('2026-09-17T08:00:00.000Z'),
};

function toolCall(id: string, toolName: string): RunCall {
  return {
    kind: 'tool',
    id,
    createdAt: new Date('2026-09-17T08:00:10.000Z'),
    turn: 1,
    step: {
      kind: 'tool',
      toolName,
      toolCallId: null,
      jobId: RUN_ID,
      card: null,
      presented: null,
      input: { query: 'veille' },
      outputText: 'trois articles',
      outcome: 'success',
      durationMs: 320,
      lineCounts: {},
      question: null,
    },
  };
}

function modelCall(id: string, model: string): RunCall {
  return {
    kind: 'model',
    id,
    createdAt: new Date('2026-09-17T08:00:05.000Z'),
    turn: 1,
    model,
    provider: 'openrouter',
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.008,
    durationMs: 900,
    failover: false,
    error: null,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <table>
        <tbody>
          <RunRow run={run} columns={8} />
        </tbody>
      </table>,
    );
  });
}

function cell(name: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="${name}"]`);
  if (el === null) throw new Error(`cellule ${name} absente de la ligne`);
  return el;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  listRunCallsAction.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('RunRow — la ligne repliée @cap:suivre-execution/ecran', () => {
  it('porte les sept éléments du run, et rien de ses appels', async () => {
    await render();

    expect(cell('run-agent').textContent).toContain('Alfred');
    expect(cell('run-origin').textContent).toContain('Telegram');
    expect(cell('run-task').textContent).toContain('Poster le résumé');
    expect(cell('run-status').textContent).toContain('Done');
    expect(cell('run-duration').textContent).toContain('4.2 s');
    // Le formateur du produit (`formatCost`) : deux decimales des 1 cent.
    expect(cell('run-cost').textContent).toContain('$0.01');
    expect(cell('run-calls').textContent).toContain('3 calls');

    // Repliée, la ligne n'a demandé aucun appel : c'est la page qui reste
    // légère, un run à la fois.
    expect(listRunCallsAction).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('notion_search');
  });
});

describe('RunRow — la ligne dépliée @cap:suivre-execution/ecran', () => {
  it('demande les appels de CE run au dépliage, et les montre dans l’ordre rendu', async () => {
    listRunCallsAction.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          modelCall('m1', 'glm-5.3'),
          toolCall('t1', 'notion_search'),
          toolCall('t2', 'send_telegram'),
        ],
        page: 1,
        pageSize: 50,
        hasMore: false,
        total: 3,
      },
    });
    await render();

    await act(async () => {
      container.querySelector<HTMLElement>(`[data-testid="run-row-${RUN_ID}"]`)!.click();
    });

    // L'argument, pas le nombre d'appels : le run demandé est bien celui-ci.
    expect(listRunCallsAction).toHaveBeenCalledWith({ jobId: RUN_ID, page: 1, pageSize: 50 });

    const deplie = container.querySelector<HTMLElement>(`[data-testid="run-calls-${RUN_ID}"]`);
    expect(deplie, 'la ligne dépliée est absente').not.toBeNull();

    const texte = deplie!.textContent ?? '';
    const rangs = ['glm-5.3', 'notion_search', 'send_telegram'].map((mot) => texte.indexOf(mot));
    expect(
      rangs.every((r) => r >= 0),
      `un bloc manque : ${texte}`,
    ).toBe(true);
    // Entrelacés, dans l'ordre que l'action a rendu : modèle, outil, outil.
    expect(rangs).toEqual([...rangs].sort((a, b) => a - b));

    // L'appel de modèle dit ce qu'il a coûté ; l'appel d'outil dit son nom et
    // son argument. Depuis #135, sa SORTIE attend le clic — le bloc d'outil du
    // fil est replié par défaut, ici comme dans une conversation.
    expect(texte).toContain('1,200 in / 300 out');
    expect(texte).toContain('(veille)');
    expect(texte).not.toContain('trois articles');
    // Et la ligne d'un run garde son adresse.
    expect(deplie!.querySelector('a')?.getAttribute('href')).toBe(`/jobs/${RUN_ID}`);
  });

  it('propose d’en montrer 50 de plus quand le run en a davantage, et les ajoute', async () => {
    listRunCallsAction.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [toolCall('t1', 'notion_search')],
        page: 1,
        pageSize: 50,
        hasMore: true,
        total: 2,
      },
    });
    await render();
    await act(async () => {
      container.querySelector<HTMLElement>(`[data-testid="run-row-${RUN_ID}"]`)!.click();
    });

    const bouton = [...container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Show 50 more'),
    );
    expect(bouton, 'le bouton « show more » manque alors que le run a une suite').toBeDefined();

    listRunCallsAction.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [toolCall('t2', 'send_telegram')],
        page: 2,
        pageSize: 50,
        hasMore: false,
        total: 2,
      },
    });
    await act(async () => {
      bouton!.click();
    });

    expect(listRunCallsAction).toHaveBeenLastCalledWith({ jobId: RUN_ID, page: 2, pageSize: 50 });
    const texte = container.querySelector<HTMLElement>(
      `[data-testid="run-calls-${RUN_ID}"]`,
    )!.textContent!;
    // La suite s'AJOUTE : la première page est toujours là.
    expect(texte).toContain('notion_search');
    expect(texte).toContain('send_telegram');
  });

  it('un run en cours fait avancer le compteur de sa ligne repliée', async () => {
    vi.useFakeTimers();
    try {
      const enCours: ActivityRunRow = { ...run, status: 'processing', callCount: 1 };
      listRunCallsAction.mockResolvedValue({
        ok: true,
        data: {
          items: [toolCall('t1', 'notion_search')],
          page: 1,
          pageSize: 50,
          hasMore: false,
          total: 7,
        },
      });

      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root.render(
          <table>
            <tbody>
              <RunRow run={enCours} columns={8} defaultExpanded />
            </tbody>
          </table>,
        );
      });

      // Le total que l'action rend prend la place du compte figé de la page.
      expect(cell('run-calls').textContent).toContain('7 calls');

      listRunCallsAction.mockResolvedValue({
        ok: true,
        data: {
          items: [toolCall('t1', 'notion_search'), toolCall('t2', 'send_telegram')],
          page: 1,
          pageSize: 50,
          hasMore: false,
          total: 9,
        },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });

      expect(cell('run-calls').textContent).toContain('9 calls');
      expect(
        container.querySelector<HTMLElement>(`[data-testid="run-calls-${RUN_ID}"]`)!.textContent,
      ).toContain('send_telegram');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Ce que suivre un run coûte ───────────────────────────────────────────────
//
// Un run bloqué en `processing` — le cas même que cette page sert à voir — est
// suivi par une ligne que personne ne referme. Sans garde-fou, un onglet oublié
// demande ses appels toutes les trois secondes jusqu'au matin : près de trente
// mille requêtes. Ces trois cas tiennent les trois garde-fous, et chacun tombe
// en rouge si on retire le sien (mutations vérifiées : plafond retiré, délai
// constant, `visibilityState` ignoré).

/** Monte la ligne d'un run EN COURS, déjà dépliée, et rend le premier appel. */
async function renderEnCours(): Promise<void> {
  const enCours: ActivityRunRow = { ...run, status: 'processing', callCount: 1 };
  listRunCallsAction.mockResolvedValue({
    ok: true,
    data: {
      items: [toolCall('t1', 'notion_search')],
      page: 1,
      pageSize: 50,
      hasMore: false,
      total: 1,
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <table>
        <tbody>
          <RunRow run={enCours} columns={8} defaultExpanded />
        </tbody>
      </table>,
    );
  });
}

describe('RunRow — suivre un run coûte, et ça s’arrête @cap:suivre-execution/ecran', () => {
  it('s’espace : après cinq minutes, trois secondes ne demandent plus rien, trente secondes si', async () => {
    vi.useFakeTimers();
    try {
      await renderEnCours();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      const apresCinqMinutes = listRunCallsAction.mock.calls.length;
      // Le rythme rapide a bien tourné pendant ces cinq minutes.
      expect(apresCinqMinutes).toBeGreaterThan(50);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(listRunCallsAction.mock.calls.length).toBe(apresCinqMinutes);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(listRunCallsAction.mock.calls.length).toBe(apresCinqMinutes + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('s’arrête au bout d’une demi-heure, et le DIT', async () => {
    vi.useFakeTimers();
    try {
      await renderEnCours();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(31 * 60_000);
      });
      const auPlafond = listRunCallsAction.mock.calls.length;

      // La ligne le dit — un suivi qui s'arrête en silence se lirait comme un
      // run qui ne fait plus rien.
      expect(container.querySelector('[data-testid="run-follow-stopped"]')?.textContent).toContain(
        'Stopped following',
      );

      // Et plus rien n'est demandé, jamais : une heure de plus ne bouge pas.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60_000);
      });
      expect(listRunCallsAction.mock.calls.length).toBe(auPlafond);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ne demande rien quand l’onglet est caché', async () => {
    vi.useFakeTimers();
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      await renderEnCours();
      // Le dépliage lui-même a lu une fois : c'est le geste du lecteur.
      const auDepliage = listRunCallsAction.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(listRunCallsAction.mock.calls.length).toBe(auDepliage);
    } finally {
      delete (document as unknown as Record<string, unknown>)['visibilityState'];
      if (visibility) Object.defineProperty(Document.prototype, 'visibilityState', visibility);
      vi.useRealTimers();
    }
  });
});
