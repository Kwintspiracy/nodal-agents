// DeliveryBlock.test.tsx — la conclusion du travail (P2bis, redessinée #135).
//
// L'enjeu du test n'est pas ce qu'il montre : c'est ce qu'il TAIT. La maquette
// porte six cellules ; deux n'ont pas de source. Un travail sans preuve n'a ni
// « Tests » ni « Proof », et surtout pas un « 0 / 0 » qui laisserait croire
// que les tests ont tourné. Elle écrit aussi « 3 passed » après une commande :
// le modèle n'a qu'un verdict par commande, et le compte n'est pas inventé.
//
// Et le calcul lui-même, dans le modèle : `deliverySummary` ne compte que les
// fichiers ÉCRITS, ramasse les délégués en relectures, et ne rend un verdict
// que si une preuve a tourné.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Le bouton Stop de l'encart lit le routeur de Next ; hors de l'app, il n'y a
// pas de routeur monté (« invariant expected app router to be mounted »).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

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
  filePaths: [],
  lines: null,
  tests: null,
  durationMs: null,
  costUsd: null,
  reviews: [],
  checks: [],
  verdict: null,
  review: null,
  changesRequested: false,
  commands: [],
  produced: true,
  ended: null,
  live: null,
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
  agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
  model: null,
  at: null,
  usage: null,
  blocks: cards.map((step) => ({ kind: 'card' as const, step })),
});

function summaryOf(over: Partial<ThreadJob> & { feed: ConversationFeed }): DeliverySummary {
  const job: ThreadJob = {
    jobId: 'j1',
    createdAt: null,
    completedAt: null,
    status: null,
    result: null,
    resultKind: null,
    verdict: travail,
    project: null,
    proof: [],
    reviewVerdict: null,
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
      agentAvatarUrl: null,
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
            // #135 — l'item dit aussi qui a délégué : la tête du fil, Alfred.
            from: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
            job: {
              id: 'j2',
              agentName: 'Le Codeur',
              agentSlug: 'codeur',
              agentAvatarUrl: null,
              status: 'completed',
              task: 'écris le service',
              result: 'TokenService extrait',
              error: null,
              failureHint: null,
              createdAt: null,
              completedAt: null,
            },
          },
        ],
        totals: totals(),
      },
    });
    expect(summary.files).toBe(2);
    // #135 — les chemins EUX-MÊMES, dans l'ordre d'écriture, dédoublonnés
    // comme le compte : la liste et le nombre ne peuvent plus diverger.
    expect(summary.filePaths).toEqual(['src/a.ts', 'src/c.ts']);
    expect(summary.files).toBe(summary.filePaths.length);
    expect(summary.reviews).toEqual([
      {
        name: 'Le Codeur',
        text: 'TokenService extrait',
        ok: true,
        isAgent: true,
        avatarUrl: null,
      },
    ]);
  });

  it('la relecture d’un délégué porte SON image quand il en a une (#135)', () => {
    const summary = summaryOf({
      feed: {
        items: [
          {
            kind: 'child',
            from: { name: 'Marlowe', slug: 'marlowe', avatarUrl: null },
            job: {
              id: 'j2',
              agentName: 'Vega Orin',
              agentSlug: 'vega-orin',
              agentAvatarUrl: '/avatars/vega.png',
              status: 'completed',
              task: 'relis la livraison',
              result: 'Approved, one minor note',
              error: null,
              failureHint: null,
              createdAt: null,
              completedAt: null,
            },
          },
        ],
        totals: totals(),
      },
    });
    expect(summary.reviews[0]?.avatarUrl).toBe('/avatars/vega.png');
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

  it('l’issue d’un travail arrêté ou tombé voyage jusqu’à l’encart ; un travail fini n’en a pas', () => {
    const vide = { items: [], totals: totals() };
    expect(summaryOf({ feed: vide, status: 'cancelled' }).ended).toBe('stopped');
    expect(summaryOf({ feed: vide, status: 'failed' }).ended).toBe('failed');
    expect(summaryOf({ feed: vide, status: 'completed' }).ended).toBeNull();
    expect(summaryOf({ feed: vide, status: 'processing' }).ended).toBeNull();
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
      {
        name: 'cli:codex_review',
        text: 'Two blockers',
        ok: false,
        isAgent: false,
        avatarUrl: null,
      },
    ]);
  });
});

describe('DeliveryBlock — ce que l’écran dessine', () => {
  it('un travail sans rien de prouvé dit qu’il n’est pas vérifié, et n’a aucune section', () => {
    const html = renderToStaticMarkup(<DeliveryBlock summary={EMPTY} jobId={null} />);
    // #135 — le mot du résultat, pas le nom d'un encart.
    expect(html).toContain('Delivered');
    expect(html).not.toContain('Delivery summary');
    expect(html).toContain('Not verified');
    // Le crochet reste VERT : il dit « livré », pas « vérifié » — c'est la
    // pastille qui dit la preuve (Quentin, 18/09). Gris, un run livré sans
    // preuve avait l'air éteint.
    expect(html).toMatch(/<svg[^>]*class="[^"]*text-ok/);
    expect(html).not.toMatch(/<svg[^>]*class="[^"]*text-ink-4/);
    expect(html).not.toContain('Tests');
    expect(html).not.toContain('Proof');
    expect(html).not.toContain('Reviewed by');
    // Sans écriture textuelle, pas de cellule « Lines » ; « Coverage » n'a de
    // toute façon aucune source.
    expect(html).not.toContain('Lines');
    expect(html).not.toContain('Coverage');
    // Sans run à ouvrir ET sans relecture, pas de pied du tout.
    expect(html).not.toContain('Open run');
    // Pleine largeur : le récapitulatif conclut le travail, il n'est pas plus
    // étroit que les blocs qu'il conclut (#135).
    expect(html).not.toContain('ml-[46px]');
    expect(html).not.toContain('pl-[46px]');
  });

  it('les cellules PRÉSENTES sont celles qui ont une source, aux styles de la maquette', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        jobId="job-7"
        summary={{
          ...EMPTY,
          files: 3,
          filePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
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
            {
              name: 'Vega Orin',
              text: 'Approved, one minor note',
              ok: true,
              isAgent: true,
              avatarUrl: null,
            },
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
    expect(html).toContain('Vega Orin');
    expect(html).toContain('pnpm lint');
    // L'étiquette est Mono/11 en ink-4, la valeur Medium/14 — plus de micro
    // capitales, plus de Mono/13.
    expect(html).toMatch(/class="[^"]*text-mono-11[^"]*text-ink-4[^"]*"[^>]*>Files</);
    expect(html).toMatch(/class="[^"]*text-medium-14[^"]*"[^>]*>3</);
    expect(html).not.toContain('text-micro-10');
    // La durée est une mesure : elle prend la couleur des mesures.
    expect(html).toMatch(/class="[^"]*text-medium-14 text-feed-metric[^"]*"[^>]*>4 min 12</);
    expect(html).not.toMatch(/text-\[\d/);
  });

  it('les fichiers livrés sont NOMMÉS, un par ligne, en couleur de chemin (#135)', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        jobId="job-7"
        summary={{ ...EMPTY, files: 2, filePaths: ['src/a.ts', 'apps/web/src/b.tsx'] }}
      />,
    );
    expect(html).toMatch(/class="[^"]*text-mono-12 text-feed-path[^"]*"[^>]*>src\/a\.ts</);
    expect(html).toContain('apps/web/src/b.tsx');
    expect(html).not.toContain('and 0 more');
  });

  it('au-delà de douze fichiers, la liste s’arrête et COMPTE le reste', () => {
    const paths = Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`);
    const html = renderToStaticMarkup(
      <DeliveryBlock jobId="job-7" summary={{ ...EMPTY, files: 15, filePaths: paths }} />,
    );
    expect(html).toContain('src/f11.ts');
    expect(html).not.toContain('src/f12.ts');
    expect(html).toContain('… and 3 more');
  });

  it('la preuve s’appelle « Proof », et chaque commande porte son sort', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        jobId="job-7"
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
    expect(html).toContain('Proof');
    expect(html).not.toContain('>Checks<');
    expect(html).toMatch(/class="[^"]*text-mono-12 text-ink-2[^"]*"[^>]*>pnpm lint</);
    // Une coche verte et une croix d'alerte : deux icônes, deux couleurs.
    expect(html).toContain('text-ok');
    expect(html).toContain('text-warn');
    // La maquette écrit « 3 passed » après la commande ; `ThreadProofRun` ne
    // porte pas de compte de cas. Rien n'est inventé.
    expect(html).not.toContain('passed<');
  });

  it('le pied dit QUI a relu, avec son image, et ouvre le run', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        jobId="job-7"
        summary={{
          ...EMPTY,
          reviews: [
            {
              name: 'Vega Orin',
              text: 'Approved',
              ok: true,
              isAgent: true,
              avatarUrl: '/avatars/vega.png',
            },
            {
              name: 'cli:codex_review',
              text: 'Two blockers',
              ok: false,
              isAgent: false,
              avatarUrl: null,
            },
          ],
        }}
      />,
    );
    expect(html).toContain('Reviewed by');
    expect(html).toContain('vega.png');
    expect(html).toMatch(/class="[^"]*text-medium-13[^"]*"[^>]*>Vega Orin</);
    // Un verdict d'outil n'a pas d'avatar, et son nom perd le préfixe du harnais.
    expect(html).toContain('codex_review');
    expect(html).not.toContain('cli:codex_review');
    expect(html).toContain('Open run');
    expect(html).toContain('href="/scheduled/job-7"');
    // Une relecture qui a dit NON ne se lit pas comme les autres : son nom
    // prend la couleur d'alerte et le dit au survol — la planche ne dessine
    // pas de point, c'est le nom qui porte le verdict.
    expect(html).toMatch(
      /class="[^"]*text-warn[^"]*" title="This review said no"[^>]*>codex_review</,
    );
    expect(html).not.toMatch(/text-warn[^>]*>Vega Orin</);
    expect(html).not.toContain('rounded-full');
  });

  it('sans run, le pied garde les relectures et PERD le lien', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        jobId={null}
        summary={{
          ...EMPTY,
          reviews: [
            { name: 'Vega Orin', text: 'Approved', ok: true, isAgent: true, avatarUrl: null },
          ],
        }}
      />,
    );
    expect(html).toContain('Reviewed by');
    expect(html).toContain('Vega Orin');
    expect(html).not.toContain('Open run');
    expect(html).not.toContain('/scheduled/');
  });
});

// ─── #59 — « Delivered toujours, et le verdict à côté » ─────────────────────
//
// Quentin, 19/09 au soir, devant le bloc sur la stack. Une première version
// remplaçait le mot par « Changes requested » : un run relu a pourtant bien
// livré quelque chose, et effacer « Delivered » revenait à dire que le travail
// n'avait pas eu lieu. Le bloc dit donc les DEUX faits, côte à côte.

/**
 * Ce que la ligne DIT, balises retirées : `renderToStaticMarkup` coupe
 * « Delivered · Approved » en deux par le `<span>` qui porte la couleur du
 * verdict, si bien qu'aucune assertion sur le texte entier ne tiendrait sur le
 * HTML brut. C'est pourtant l'ordre des mots qui se lit à l'écran.
 */
function ligne(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

describe('DeliveryBlock — le verdict à côté @cap:verifier-un-livrable/ecran', () => {
  it('dit « Delivered » ET « Changes requested », jamais l’un à la place de l’autre', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        jobId="job-59"
        summary={{
          ...EMPTY,
          review: 'request_changes',
          changesRequested: true,
          files: 2,
          filePaths: ['src/a.ts', 'src/b.ts'],
          tests: { passed: 2, total: 2 },
          verdict: 'green',
          checks: [{ command: 'pnpm test', ok: true }],
        }}
      />,
    );
    // La ligne ENTIÈRE, telle qu'elle se lit : les deux mots, dans cet ordre,
    // séparés par le point médian. Deux `toContain` séparés passeraient sur une
    // page qui les afficherait à deux endroits sans rapport.
    expect(ligne(html)).toContain('Delivered · Changes requested');
    // La pastille NOMME qui a tranché, et prend la place de « Verified » : le
    // fait le plus frais du bloc est la relecture, pas la preuve, qui garde son
    // sort dans « Proof » juste dessous.
    expect(html).toContain('By the reviewer');
    expect(html).not.toContain('Verified');
    // Le SIGNE, lui, vire : c'est ce qui reste pour dire qu'il y a à reprendre.
    // Lu sur l'EN-TÊTE seul — les crochets des commandes de preuve, plus bas,
    // disent autre chose et restent verts.
    const entete = html.slice(0, html.indexOf('Delivered'));
    expect(entete).toMatch(/<svg[^>]*class="[^"]*text-warn/);
    expect(entete).not.toMatch(/<svg[^>]*class="[^"]*text-ok/);
    // Ce que le travail a fait reste montré — le bloc n'efface rien.
    expect(html).toContain('src/a.ts');
    expect(html).toContain('pnpm test');
  });

  it('un approve se lit « Delivered · Approved », pastille verte', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        jobId="job-59"
        summary={{
          ...EMPTY,
          review: 'approve',
          changesRequested: false,
          commands: [],
          produced: true,
          ended: null,
          live: null,
          verdict: 'green',
        }}
      />,
    );
    // La même assertion que le cas du dessus : la ligne entière, dans l'ordre.
    expect(ligne(html)).toContain('Delivered · Approved');
    expect(html).toContain('By the reviewer');
    expect(html).not.toContain('Changes requested');
    // Approuvé, donc le signe reste vert.
    const entete = html.slice(0, html.indexOf('Delivered'));
    expect(entete).toMatch(/<svg[^>]*class="[^"]*text-ok/);
  });

  it('sans relecture, la ligne n’a qu’un fait et garde « Verified »', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock jobId="job-59" summary={{ ...EMPTY, verdict: 'green' }} />,
    );
    expect(ligne(html)).toContain('Delivered');
    // Rien n'est accroché derrière : pas de point médian après le mot.
    expect(ligne(html)).not.toContain('Delivered ·');
    expect(html).toContain('Verified');
    expect(html).not.toContain('By the reviewer');
    expect(html).not.toContain('Approved');
    expect(html).not.toContain('Changes requested');
  });

  it('un verdict que l’écran ne connaît pas s’affiche tel quel, jamais avalé', () => {
    // Invariant #4 : une relecture qu'on ne sait pas nommer a quand même eu
    // lieu. La taire serait pire que la nommer mal.
    const html = renderToStaticMarkup(
      <DeliveryBlock
        jobId="job-59"
        summary={{
          ...EMPTY,
          review: 'abstained',
          changesRequested: false,
          commands: [],
          produced: true,
          ended: null,
          live: null,
          verdict: 'green',
        }}
      />,
    );
    expect(ligne(html)).toContain('Delivered · abstained');
    expect(html).toContain('By the reviewer');
  });
});

describe('deliverySummary — le verdict de la relecture @cap:verifier-un-livrable/moteur', () => {
  it('reporte le dernier verdict du travail, et s’il demande des corrections', () => {
    const bloque = summaryOf({
      feed: { items: [], totals: totals() },
      reviewVerdict: 'request_changes',
    });
    expect(bloque.review).toBe('request_changes');
    expect(bloque.changesRequested).toBe(true);

    const passe = summaryOf({ feed: { items: [], totals: totals() }, reviewVerdict: 'approve' });
    expect(passe.review).toBe('approve');
    expect(passe.changesRequested).toBe(false);

    const sansRelecture = summaryOf({ feed: { items: [], totals: totals() } });
    expect(sansRelecture.review).toBeNull();
    expect(sansRelecture.changesRequested).toBe(false);
  });
});

// ─── #282 — une commande qu'on n'a pas vue se LIT dans l'encart ──────────────
//
// Jusqu'au 21/09 le fil ne disait RIEN d'un tour dont la seule commande n'avait
// laissé aucune écriture constatée : ni encart (le verdict dit « pas du
// travail »), ni note (rien d'inclassable). Le verdict avait mesuré une
// absence, et cette absence ne se lisait nulle part.
//
// Décision de Quentin : l'encart, avec la commande marquée. Ce qui suit prouve
// les deux moitiés — la commande est nommée, et le mot de l'en-tête ne promet
// pas une livraison qui n'a pas eu lieu.

describe('DeliveryBlock — une commande non constatée @cap:verifier-un-livrable/ecran', () => {
  it('nomme la commande et dit que rien n’a été observé', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        summary={{
          ...EMPTY,
          produced: false,
          ended: null,
          live: null,
          commands: [{ label: 'ls -la', observed: false }],
        }}
        jobId={null}
      />,
    );
    expect(html).toContain('Commands');
    expect(html).toContain('ls -la');
    expect(html).toContain('no file change seen');
    // ET LE MOT N'EST PLUS « DELIVERED ». Rien n'a été constaté : écrire
    // « Delivered » au-dessus de cette liste dirait le contraire du verdict.
    expect(html).toContain('>Ran');
    expect(html).not.toContain('Delivered');
    // ET LE SIGNE S'ÉTEINT au lieu de virer au rouge : une absence est grise et
    // se dit, jamais rouge. Sans cette assertion, la couleur du crochet était
    // la seule mutation du lot qui restait verte (Reviewer C, passe 1).
    expect(html).toContain('text-ink-4');
    expect(html).not.toContain('text-ok');
  });

  // Quentin, 22/09 : « j'ai cancel un run mais il apparaît comme delivered et
  // verified, c'est possible ça ? ». Ce que le run a écrit avant l'arrêt reste
  // listé ; le mot de l'en-tête, lui, dit l'issue.
  it('un run arrêté dit « Stopped », un run tombé « Failed », quoi qu’ils aient écrit', () => {
    const arrete = renderToStaticMarkup(
      <DeliveryBlock
        summary={{
          ...EMPTY,
          produced: true,
          files: 2,
          filePaths: ['a.ts', 'b.ts'],
          ended: 'stopped',
        }}
        jobId={null}
      />,
    );
    expect(arrete).toContain('>Stopped');
    expect(arrete).not.toContain('Delivered');
    // Les fichiers restent nommés : l'arrêt n'efface pas ce qui a été écrit.
    expect(arrete).toContain('a.ts');
    // Et le crochet ne se peint pas en vert pour un travail qui n'est pas allé au bout.
    expect(arrete).toContain('text-ink-4');
    expect(arrete).not.toContain('text-ok');

    const tombe = renderToStaticMarkup(
      <DeliveryBlock summary={{ ...EMPTY, produced: true, ended: 'failed' }} jobId={null} />,
    );
    expect(tombe).toContain('>Failed');
    expect(tombe).not.toContain('Delivered');
  });

  // Quentin, 22/09 : « pourquoi je ne peux pas stopper le run depuis le chat,
  // il y a un bouton Open run ». L'encart paraît sur un run qui court dès
  // qu'il a produit ; le bouton Stop vit à côté du lien, pour CE job.
  it('porte le bouton Stop à côté d’« Open run » tant que le run court, et plus après', () => {
    const enCours = renderToStaticMarkup(
      <DeliveryBlock summary={{ ...EMPTY, produced: true }} jobId="job-9" status="processing" />,
    );
    expect(enCours).toContain('data-testid="stop-run"');
    expect(enCours).toContain('data-job-id="job-9"');
    expect(enCours).toContain('Open run');

    const fini = renderToStaticMarkup(
      <DeliveryBlock summary={{ ...EMPTY, produced: true }} jobId="job-9" status="completed" />,
    );
    expect(fini).not.toContain('data-testid="stop-run"');
    expect(fini).toContain('Open run');

    // Sans job à ouvrir, rien à arrêter non plus : le statut seul ne suffit pas.
    const sansJob = renderToStaticMarkup(
      <DeliveryBlock summary={{ ...EMPTY, produced: true }} jobId={null} status="processing" />,
    );
    expect(sansJob).not.toContain('data-testid="stop-run"');
  });

  // Quentin, 22/09 : « comment le contenu qui est en Working peut être
  // verified ? Non fini mais verified ? ». Tant que ça court, les preuves déjà
  // passées se comptent ; « Verified » attend la fin.
  it('tant que le run court, les preuves se comptent et rien n’est « Verified »', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        summary={{ ...EMPTY, live: 'working', tests: { passed: 1, total: 1 }, verdict: 'green' }}
        jobId="job-9"
        status="processing"
      />,
    );
    expect(html).toContain('1 check passed so far');
    expect(html).not.toContain('>Verified');
    const sansPreuve = renderToStaticMarkup(
      <DeliveryBlock summary={{ ...EMPTY, live: 'working' }} jobId="job-9" status="processing" />,
    );
    expect(sansPreuve).toContain('No checks yet');
    expect(sansPreuve).not.toContain('Not verified');
  });

  // Quentin, 22/09 : « dans le footer du cadre, aligne Open run à droite et
  // fais-en un vrai bouton ».
  it('« Open run » est un bouton, seul au bord droit du pied', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock summary={{ ...EMPTY }} jobId="job-7" status="completed" />,
    );
    const at = html.indexOf('Open run');
    const before = html.slice(Math.max(0, at - 400), at);
    expect(before).toContain('ml-auto');
    expect(before).toContain('href="/scheduled/job-7"');
    // Le bouton neutre du design system, pas un lien en texte.
    expect(before).toMatch(/<a[^>]*class="[^"]*inline-flex/);
  });

  // Quentin, 22/09 : « j'ai à la fois un panneau Delivered avec un crochet
  // vert, un bouton Stop et un tab Running en haut ». Tant que ça travaille,
  // rien n'est livré : le mot et le signe prennent la couleur de « Running ».
  it('tant que le run court, l’en-tête dit « Working » dans la couleur de Running, sans crochet', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        summary={{ ...EMPTY, produced: true, live: 'working' }}
        jobId="job-9"
        status="processing"
      />,
    );
    expect(html).toContain('>Working');
    expect(html).not.toContain('Delivered');
    // Le crochet vert attend la fin ; l'icône est celle du travail en cours,
    // et elle est VERROUILLÉE (Reviewer C, #337) : le mot seul ne suffit pas.
    const head = html.slice(html.indexOf('data-testid="delivery-head"'));
    const headOnly = head.slice(0, head.indexOf('</div>'));
    expect(headOnly).toContain('animate-spin');
    expect(headOnly).toContain('text-run');
    expect(html).not.toContain('text-ok');
    // Et le bouton Stop est DANS L'EN-TÊTE, à droite, pas dans le pied.
    expect(headOnly).toContain('data-testid="stop-run"');
    expect(headOnly).toContain('ml-auto');
    // Un seul bouton sur tout l'encart : celui de l'en-tête, plus celui du pied.
    expect(html.split('data-testid="stop-run"').length - 1).toBe(1);
  });

  // Un run bloqué sur une approbation est vivant mais ne travaille pas : pas de
  // spinner, le mot dit qu'il attend la personne (Reviewer C, #337).
  it('un run qui attend une approbation dit « Waiting for you », sans spinner', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        summary={{ ...EMPTY, produced: true, live: 'waiting' }}
        jobId="job-9"
        status="awaiting_approval"
      />,
    );
    expect(html).toContain('>Waiting for you');
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('Working');
    expect(html).not.toContain('Delivered');
    // Toujours arrêtable d'ici.
    expect(html).toContain('data-testid="stop-run"');
  });

  it('liveKind : working, waiting, ou rien', async () => {
    const { liveKind } = await import('@/lib/job-live.ts');
    expect(liveKind('processing')).toBe('working');
    expect(liveKind('pending')).toBe('working');
    expect(liveKind('awaiting_approval')).toBe('waiting');
    expect(liveKind('completed')).toBeNull();
    expect(liveKind('cancelled')).toBeNull();
    expect(liveKind(null)).toBeNull();
  });

  it('montre douze commandes au plus, et COMPTE le reste', () => {
    // `classifyProduction` pousse un item par ligne terminal réussie, sans
    // plafond : une session de code de cent cinquante appels shell rendait un
    // encart plus long que le fil qu'il conclut (Reviewer C, passe 1).
    const quinze = Array.from({ length: 15 }, (_, i) => ({
      label: `commande-${i}`,
      observed: i % 2 === 0,
    }));
    const html = renderToStaticMarkup(
      <DeliveryBlock summary={{ ...EMPTY, commands: quinze }} jobId={null} />,
    );
    // LES DOUZE PREMIÈRES, DANS L'ORDRE. Sans la borne basse, un découpage
    // arbitraire gardant douze items dont le onzième serait resté vert
    // (Reviewer C, passe 2).
    expect(html).toContain('commande-0');
    expect(html).toContain('commande-11');
    expect(html).not.toContain('commande-12');
    // Les trois qui restent sont COMPTÉES, pas jetées — et la phrase est celle
    // des COMMANDES, pas celle des fichiers, qui est la même au mot près.
    expect(html).toContain('data-testid="commands-more"');
    expect(html).toContain('… and 3 more');
  });

  it('ne compte rien quand la liste de commandes tient en entier', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        summary={{ ...EMPTY, commands: [{ label: 'ls -la', observed: false }] }}
        jobId={null}
      />,
    );
    // « … and 0 more » demande d'être lu pour apprendre qu'il n'y a rien de
    // plus. Les fichiers avaient déjà ce garde-fou ; les commandes ne l'avaient
    // pas (Reviewer C, passe 2).
    expect(html).not.toContain('commands-more');
    expect(html).not.toContain('more');
  });

  it('dit « Delivered » et tait l’aveu quand la commande a été constatée', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock
        summary={{
          ...EMPTY,
          produced: true,
          ended: null,
          live: null,
          files: 1,
          filePaths: ['out/bilan.md'],
          commands: [{ label: 'pnpm build', observed: true }],
        }}
        jobId={null}
      />,
    );
    expect(html).toContain('Delivered');
    expect(html).toContain('pnpm build');
    expect(html).not.toContain('no file change seen');
  });

  it('ne dessine aucune section Commands quand le travail n’en a fait tourner aucune', () => {
    const html = renderToStaticMarkup(
      <DeliveryBlock summary={{ ...EMPTY, files: 1, filePaths: ['a.md'] }} jobId={null} />,
    );
    expect(html).not.toContain('Commands');
    expect(html).not.toContain('no file change seen');
  });
});
