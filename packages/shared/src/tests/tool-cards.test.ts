// tool-cards.test.ts — la forme de chaque carte (P1, plan « De la maquette au
// produit »). Ce que l'écran lira sur `tool_calls.presented` est exactement ce
// que ces schémas acceptent — rien de plus large.

import { describe, it, expect } from 'vitest';
import {
  TOOL_CARDS,
  ToolCardPayloadSchema,
  CARDS_NEEDING_PRESENTER,
  CARD_ROWS_MAX,
  CARD_ITEMS_MAX,
  CARD_TEXT_MAX,
} from '../index';

const terminal = {
  card: 'terminal',
  command: 'ls',
  exitCode: 0,
  timedOut: false,
  stdoutTail: '',
  stdoutTruncated: false,
  stderrTail: '',
  stderrTruncated: false,
};

const table = (rows: unknown[][]) => ({
  card: 'table',
  tables: [
    {
      columns: ['a'],
      header: 'columns',
      rows,
      total: rows.length,
      truncated: false,
      clipped: false,
    },
  ],
});

describe('ToolCardPayloadSchema — une forme par carte', () => {
  it("chaque carte du vocabulaire a sa forme, et aucune forme n'est orpheline", () => {
    const shapes = ToolCardPayloadSchema.options.map((o) => o.shape.card.value);
    expect([...shapes].sort()).toEqual([...TOOL_CARDS].sort());
  });

  it('les cartes à structure sont exactement celles qui exigent un présentateur', () => {
    expect([...CARDS_NEEDING_PRESENTER].sort()).toEqual(
      // `question` en fait partie depuis P10a : `ask_user` la déclare, et sa
      // charge utile (la question, les options, la réponse) ne se déduit
      // d'aucune sortie toute seule.
      [
        'read',
        'search',
        'files',
        'table',
        'terminal',
        'sent',
        'checks',
        'delegation',
        'question',
      ].sort(),
    );
  });

  it('accepte une charge utile de chaque carte', () => {
    const samples = [
      { card: 'text', text: 'fait' },
      { card: 'text', text: 'rien écrit : lecture seule', failure: true, truncated: false },
      { card: 'read', path: 'a.md', excerpt: '# a', chars: 3, truncated: false },
      { card: 'search', query: 'q', hits: [{ title: 't', ref: 'r' }], total: 1, truncated: false },
      { card: 'files', files: [{ path: 'a', action: 'created' }], total: 1, truncated: false },
      table([['1'], [2], [null]]),
      {
        card: 'table',
        tables: [
          {
            columns: [],
            header: 'unknown',
            rows: [['x']],
            total: 1,
            truncated: false,
            clipped: true,
          },
        ],
      },
      terminal,
      { card: 'sent', channel: 'telegram', kind: 'message' },
      { card: 'checks', verdict: 'pass', summary: 'ok', items: [], total: 0 },
      {
        card: 'delegation',
        to: 'x',
        task: 't',
        ok: true,
        resultText: null,
        error: null,
        durationMs: null,
        costUsd: null,
      },
      { card: 'question', prompt: 'oui ?' },
      { card: 'generic' },
    ];
    for (const s of samples) {
      const r = ToolCardPayloadSchema.safeParse(s);
      expect(r.success, `${String(s.card)}: ${r.success ? '' : r.error.message}`).toBe(true);
    }
  });

  it('refuse une carte inconnue, une carte sans sa structure, et une carte hors plafond', () => {
    expect(ToolCardPayloadSchema.safeParse({ card: 'fancy' }).success).toBe(false);
    // `files` sans `files`
    expect(ToolCardPayloadSchema.safeParse({ card: 'files', total: 0 }).success).toBe(false);
    // une table de CARD_ROWS_MAX + 1 lignes : la carte se dessine, elle n'archive pas
    expect(
      ToolCardPayloadSchema.safeParse(table(Array.from({ length: CARD_ROWS_MAX + 1 }, () => ['x'])))
        .success,
    ).toBe(false);
    const hits = Array.from({ length: CARD_ITEMS_MAX + 1 }, () => ({ title: 't' }));
    expect(
      ToolCardPayloadSchema.safeParse({
        card: 'search',
        query: 'q',
        hits,
        total: 1,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      ToolCardPayloadSchema.safeParse({ card: 'text', text: 'x'.repeat(CARD_TEXT_MAX + 1) })
        .success,
    ).toBe(false);
  });

  it('ce qui a été coupé se DIT : une table sans `header`/`clipped`, un terminal sans ses drapeaux, sont refusés', () => {
    // Revue passe 14 : une charge tronquée passait pour complète.
    const { header: _h, ...sansHeader } = table([['x']]).tables[0]!;
    expect(ToolCardPayloadSchema.safeParse({ card: 'table', tables: [sansHeader] }).success).toBe(
      false,
    );
    const { stdoutTruncated: _s, ...sansDrapeau } = terminal;
    expect(ToolCardPayloadSchema.safeParse(sansDrapeau).success).toBe(false);
    // `failure` ne peut être que true : « failure: false » n'est pas un état, c'est du bruit.
    expect(
      ToolCardPayloadSchema.safeParse({ card: 'text', text: 'x', failure: false }).success,
    ).toBe(false);
  });
});
