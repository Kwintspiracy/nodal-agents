// FilePreview.test.tsx — P12 : un classeur écrit MONTRE ses premières lignes,
// et dit s'il est vérifié.
//
// Rendu en HTML depuis une charge utile `files` telle que P1 la persiste. Ce
// qui compte : les cellules paraissent, ce que l'aperçu ne montre PAS se dit,
// l'état de vérification vient de la BASE et jamais d'une devinette, et
// l'aperçu ne prend pas la place du diff de P11.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationFeedView from '../ConversationFeedView.tsx';
import type { ConversationFeed, Step } from '@/lib/conversation-feed.ts';
import type { CardPayloadFor } from '@nodal-agents/shared';

vi.mock('@/lib/file-diff-actions.ts', () => ({ getFileDiffAction: vi.fn() }));

const PREVIEW = {
  name: 'Data',
  columns: [] as string[],
  header: 'unknown' as const,
  rows: [
    ['Name', 'Score'],
    ['Alice', 90],
  ],
  total: 2,
  truncated: false,
  clipped: false,
};

function feedWith(payload: CardPayloadFor<'files'>): ConversationFeed {
  const step: Extract<Step, { kind: 'tool' }> = {
    kind: 'tool',
    toolName: 'xlsx_set_range',
    toolCallId: 'call-1',
    jobId: '11111111-1111-4111-8111-111111111111',
    card: 'files',
    presented: payload,
    input: {},
    outputText: null,
    outcome: 'success',
    durationMs: 12,
    question: null,
  };
  return {
    items: [
      {
        kind: 'turn',
        index: 1,
        turn: 1,
        turnSource: 'audit',
        agent: { name: 'Alfred', slug: 'alfred' },
        model: 'mock',
        usage: null,
        blocks: [{ kind: 'card', step }],
      },
    ],
    totals: { toolCalls: 1, costUsd: null, durationMs: 12 } as never,
  } as ConversationFeed;
}

const cardWith = (
  over: Partial<CardPayloadFor<'files'>['files'][number]> = {},
): CardPayloadFor<'files'> => ({
  card: 'files',
  files: [{ path: 'ws/report.xlsx', action: 'modified', ...over }],
  total: 1,
  truncated: false,
});

const render = (
  card: CardPayloadFor<'files'>,
  deliverables: Array<{ canonicalKey: string; status: string }> = [],
): string =>
  renderToStaticMarkup(<ConversationFeedView feed={feedWith(card)} deliverables={deliverables} />);

describe('P12 — l’aperçu du classeur sur la carte du fichier', () => {
  it('rend les CELLULES écrites, et dit ce que l’aperçu ne montre pas', () => {
    const html = render(cardWith({ preview: PREVIEW }));
    expect(html).toContain('Alice');
    expect(html).toContain('90');
    expect(html).toContain('Data');
    expect(html).toContain('values only: no formulas, formatting or merged cells');
    // L'en-tête n'est pas deviné (P1) : la carte le dit.
    expect(html).toContain('first row may or may not be a header');
  });

  it('sans aperçu, rien de plus qu’avant P12', () => {
    const html = render(cardWith());
    expect(html).toContain('ws/report.xlsx');
    expect(html).not.toContain('values only');
    expect(html).not.toContain('first row may or may not be a header');
  });

  it('un aperçu tronqué dit combien de lignes il montre', () => {
    const html = render(cardWith({ preview: { ...PREVIEW, total: 301, truncated: true } }));
    expect(html).toContain('showing 2 of 301 rows');
  });

  it('une feuille vide le DIT plutôt que de laisser un tableau muet', () => {
    const html = render(cardWith({ preview: { ...PREVIEW, rows: [], total: 0 } }));
    expect(html).toContain('empty sheet');
  });

  // ── L'état de vérification : lu, jamais inventé ─────────────────────────────

  const KEY = 'd:/ws/report.xlsx';

  it('not_configured : la carte dit qu’aucune vérification n’existe pour les documents', () => {
    const html = render(cardWith({ preview: PREVIEW, deliverableKey: KEY }), [
      { canonicalKey: KEY, status: 'not_configured' },
    ]);
    expect(html).toContain('Not verified: no checks exist for documents yet');
  });

  it('dirty : « Not yet verified »', () => {
    const html = render(cardWith({ preview: PREVIEW, deliverableKey: KEY }), [
      { canonicalKey: KEY, status: 'dirty' },
    ]);
    expect(html).toContain('Not yet verified');
    expect(html).not.toContain('no checks exist');
  });

  it('pending_approval et green portent chacun leur phrase', () => {
    expect(
      render(cardWith({ preview: PREVIEW, deliverableKey: KEY }), [
        { canonicalKey: KEY, status: 'pending_approval' },
      ]),
    ).toContain('Checks await approval');
    expect(
      render(cardWith({ preview: PREVIEW, deliverableKey: KEY }), [
        { canonicalKey: KEY, status: 'green' },
      ]),
    ).toContain('Verified');
  });

  it('aucune ligne d’état pour ce fichier : AUCUNE phrase de vérification', () => {
    // La clé est là, mais la base ne dit rien de ce document — et un statut
    // qu'on ne connaît pas ne se traduit pas non plus.
    const sansLigne = render(cardWith({ preview: PREVIEW, deliverableKey: KEY }), [
      { canonicalKey: 'd:/ws/autre.xlsx', status: 'green' },
    ]);
    const inconnu = render(cardWith({ preview: PREVIEW, deliverableKey: KEY }), [
      { canonicalKey: KEY, status: 'quelque_chose_de_neuf' },
    ]);
    for (const html of [sansLigne, inconnu]) {
      expect(html).not.toContain('Verified');
      expect(html).not.toContain('Not yet verified');
      expect(html).not.toContain('no checks exist');
      expect(html).not.toContain('Checks');
    }
  });

  it('l’aperçu n’empêche PAS le bouton de diff de P11', () => {
    const html = render(cardWith({ preview: PREVIEW, deliverableKey: KEY }), [
      { canonicalKey: KEY, status: 'dirty' },
    ]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Alice');
  });
});
