// DeliveryBlock.test.tsx — le récapitulatif de livraison (P2bis).
//
// L'enjeu du test n'est pas ce qu'il montre : c'est ce qu'il TAIT. La maquette
// porte six cellules ; deux n'ont pas de source. Un travail sans preuve n'a ni
// « Tests » ni « Checks », et surtout pas un « 0 / 0 » qui laisserait croire
// que les tests ont tourné.
//
// Et le calcul lui-même, dans le modèle : `deliverySummary` ne compte que les
// fichiers ÉCRITS, ramasse les délégués en relectures, et ne rend un verdict
// que si une preuve a tourné.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DeliveryBlock from '../DeliveryBlock.tsx';
import {
  buildConversationThread,
  type ThreadAuditRow,
  type ThreadJob,
} from '@/lib/conversation-thread.ts';
import type { ConversationFeed, DeliverySummary, FeedItem, Step } from '@/lib/conversation-feed.ts';
import type { ProductionVerdict } from '@/lib/chat-or-work.ts';

const EMPTY: DeliverySummary = {
  files: 0,
  lines: null,
  tests: null,
  durationMs: null,
  costUsd: null,
  reviews: [],
  checks: [],
  verdict: null,
};

const totals = (costUsd: number | null = null) => ({
  turns: 1,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd,
  llmDurationMs: 0,
  models: [],
});

const travail: ProductionVerdict = {
  isWork: true,
  items: [],
  more: 0,
  uncertain: 0,
  unclassified: 0,
};

const tool = (over: Partial<Extract<Step, { kind: 'tool' }>>): Extract<Step, { kind: 'tool' }> => ({
  kind: 'tool',
  toolName: 'x',
  toolCallId: 'c',
  jobId: 'j1',
  card: null,
  presented: null,
  input: {},
  outputText: null,
  outcome: 'success',
  durationMs: null,
  lineCounts: {},
  question: null,
  ...over,
});

/** Une ligne d'audit d'écriture, telle que `conversation-actions` la range sous la tête. */
const ecriture = (path: string, content: string): ThreadAuditRow => ({
  toolName: 'file_write',
  toolInput: { path, content },
  toolOutput: '{"ok":true}',
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action: 'created' }] },
});
const edition = (path: string, oldText: string, newText: string): ThreadAuditRow => ({
  toolName: 'file_edit',
  toolInput: { path, old_string: oldText, new_string: newText },
  toolOutput: '{"ok":true}',
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action: 'modified' }] },
});
/** Une lecture : le fichier est `listed`, il ne compte pas. */
const lecture = (path: string): ThreadAuditRow => ({
  toolName: 'file_read',
  toolInput: { path },
  toolOutput: '{"ok":true}',
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action: 'listed' }] },
});

const turnWith = (...cards: Array<Extract<Step, { kind: 'tool' }>>): FeedItem => ({
  kind: 'turn',
  index: 1,
  turn: 1,
  turnSource: 'audit',
  agent: { name: 'Alfred', slug: 'alfred' },
  model: null,
  usage: null,
  blocks: cards.map((step) => ({ kind: 'card' as const, step })),
});

function summaryOf(over: Partial<ThreadJob> & { feed: ConversationFeed }): DeliverySummary {
  const job: ThreadJob = {
    jobId: 'j1',
    createdAt: null,
    completedAt: null,
    verdict: travail,
    project: null,
    proof: [],
    audit: [],
    workspaceRoots: [],
    ...over,
  };
  const { items } = buildConversationThread({
    conversation: {
      id: 'c1',
      channel: 'telegram',
      chatId: '1',
      title: 't',
      agentName: 'Alfred',
      agentSlug: 'alfred',
      currentProject: null,
    },
    messages: [],
    jobs: [job],
  });
  const produced = items.find((i) => i.kind === 'produced');
  if (produced === undefined || produced.kind !== 'produced')
    throw new Error('pas d’item produced');
  return produced.summary;
}

describe('deliverySummary — ce que le modèle compte', () => {
  it('ne compte que les fichiers ÉCRITS, dédoublonnés, du job ET de ses délégués', () => {
    // Fichiers et lignes viennent des LIGNES D'AUDIT de toute la descendance
    // (`audit`), pas du fil : le fil n'assemble qu'un niveau (passe 56).
    const summary = summaryOf({
      audit: [
        ecriture('src/a.ts', 'x'),
        lecture('src/b.ts'),
        // Le délégué : le même fichier, touché une seconde fois → un seul compte.
        edition('src/a.ts', 'x', 'y'),
        ecriture('src/c.ts', 'x'),
      ],
      feed: {
        items: [
          {
            kind: 'child',
            job: {
              id: 'j2',
              agentName: 'Le Codeur',
              agentSlug: 'codeur',
              status: 'completed',
              task: 'écris le service',
              result: 'TokenService extrait',
              error: null,
              createdAt: null,
              completedAt: null,
            },
          },
        ],
        totals: totals(),
      },
    });
    expect(summary.files).toBe(2);
    expect(summary.reviews).toEqual([
      { name: 'Le Codeur', text: 'TokenService extrait', ok: true, isAgent: true },
    ]);
  });

  it('les lignes se somment sur le job ET ses délégués, à toute profondeur ; une écriture qui n’a pas eu lieu ne compte pas', () => {
    // Les compteurs viennent du même lecteur que la page Code
    // (`lineCountsOfCall`), appliqué à chaque ligne d'audit.
    const summary = summaryOf({
      audit: [
        ecriture('src/a.ts', 'l1\nl2'),
        edition('src/b.ts', 'o1\no2', 'n1\nn2\nn3\nn4\nn5'),
        // Un petit-enfant : son fil n'est jamais assemblé, sa ligne compte.
        ecriture('src/c.ts', 'x\ny\nz'),
        // En attente d'approbation : rien n'a été écrit.
        { ...ecriture('src/d.ts', 'jamais'), toolOutput: '{"outcome":"awaiting_approval"}' },
      ],
      feed: { items: [], totals: totals() },
    });
    expect(summary.lines).toEqual({ added: 10, removed: 2 });
  });

  it('sans preuve : ni tests, ni contrôles, ni verdict — jamais un « 0 / 0 »', () => {
    const summary = summaryOf({ feed: { items: [], totals: totals() } });
    expect(summary.lines).toBeNull();
    expect(summary.tests).toBeNull();
    expect(summary.checks).toEqual([]);
    expect(summary.verdict).toBeNull();
  });

  it('une preuve entièrement verte vaut « green » ; une seule qui lâche vaut « red »', () => {
    const vert = summaryOf({
      feed: { items: [], totals: totals() },
      proof: [
        { command: 'pnpm test', verdict: 'green' },
        { command: 'tsc --noEmit', verdict: 'green' },
      ],
    });
    expect(vert.verdict).toBe('green');
    expect(vert.tests).toEqual({ passed: 2, total: 2 });

    const rouge = summaryOf({
      feed: { items: [], totals: totals() },
      // Une erreur d'INFRA n'est pas un succès : elle compte comme un échec.
      proof: [
        { command: 'pnpm test', verdict: 'green' },
        { command: 'pnpm lint', verdict: 'infra_error' },
      ],
    });
    expect(rouge.verdict).toBe('red');
    expect(rouge.tests).toEqual({ passed: 1, total: 2 });
  });

  it('la durée court de l’ouverture du travail à sa fin ; inconnue tant qu’il court', () => {
    const fini = summaryOf({
      feed: { items: [], totals: totals(0.52) },
      createdAt: new Date('2026-09-07T10:00:00Z'),
      completedAt: new Date('2026-09-07T10:04:12Z'),
    });
    expect(fini.durationMs).toBe(252_000);
    expect(fini.costUsd).toBe(0.52);

    const encours = summaryOf({
      feed: { items: [], totals: totals() },
      createdAt: new Date('2026-09-07T10:00:00Z'),
    });
    expect(encours.durationMs).toBeNull();
  });

  it('un verdict d’outil de revue fait une ligne de relecture, sans avatar', () => {
    const summary = summaryOf({
      feed: {
        items: [
          turnWith(
            tool({
              toolName: 'cli:codex_review',
              card: 'checks',
              presented: {
                card: 'checks',
                verdict: 'fail',
                summary: 'Two blockers',
                total: 2,
                items: [],
              },
            }),
          ),
        ],
        totals: totals(),
      },
    });
    expect(summary.reviews).toEqual([
      { name: 'cli:codex_review', text: 'Two blockers', ok: false, isAgent: false },
    ]);
  });
});

describe('DeliveryBlock — ce que l’écran dessine', () => {
  it('un travail sans rien de prouvé dit qu’il n’est pas vérifié, et n’a aucune section', () => {
    const html = renderToStaticMarkup(<DeliveryBlock summary={EMPTY} />);
    expect(html).toContain('Delivery summary');
    expect(html).toContain('Not verified');
    expect(html).not.toContain('Tests');
    expect(html).not.toContain('Checks<');
    expect(html).not.toContain('Reviews');
    // Sans écriture textuelle, pas de cellule « Lines » ; « Coverage » n'a de
    // toute façon aucune source.
    expect(html).not.toContain('Lines');
    expect(html).not.toContain('Coverage');
    // Pleine largeur : le récapitulatif conclut le travail, il n'est pas plus
    // étroit que les blocs qu'il conclut (#135).
    expect(html).not.toContain('ml-[46px]');
    expect(html).not.toContain('pl-[46px]');
  });

  it('les cellules PRÉSENTES sont celles qui ont une source', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        summary={{
          ...EMPTY,
          files: 3,
          lines: { added: 27, removed: 2 },
          tests: { passed: 6, total: 6 },
          durationMs: 252_000,
          costUsd: 0.52,
          verdict: 'green',
          checks: [
            { command: 'pnpm test', ok: true },
            { command: 'pnpm lint', ok: true },
          ],
          reviews: [
            { name: 'Le Relecteur', text: 'Approved, one minor note', ok: true, isAgent: true },
          ],
        }}
      />,
    );
    expect(html).toContain('Files');
    expect(html).toContain('>3<');
    expect(html).toContain('Lines');
    expect(html).toContain('+27 −2');
    expect(html).toContain('6 / 6');
    expect(html).toContain('4 min 12');
    expect(html).toContain('$0.52');
    expect(html).toContain('Verified');
    expect(html).toContain('Le Relecteur');
    expect(html).toContain('Approved, one minor note');
    expect(html).toContain('pnpm lint');
    expect(html).not.toMatch(/text-\[\d/);
  });

  it('une preuve rouge dit que les contrôles ont échoué, et marque la commande fautive', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        summary={{
          ...EMPTY,
          tests: { passed: 1, total: 2 },
          verdict: 'red',
          checks: [
            { command: 'pnpm test', ok: true },
            { command: 'pnpm lint', ok: false },
          ],
        }}
      />,
    );
    expect(html).toContain('Checks failed');
    expect(html).not.toContain('Verified');
    expect(html).toContain('text-err');
  });
});
