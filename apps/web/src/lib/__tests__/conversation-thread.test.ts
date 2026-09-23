// conversation-thread.test.ts — le fil d'une conversation (P7), pur.
//
// Ce qui se prouve ici est l'ORDRE et les deux retraits : l'historique que le
// runner préfixe au transcript ne doit JAMAIS réapparaître dans un fil qui le
// contient déjà, et la demande d'un job escaladé depuis le chat devient une
// consigne repliée — l'utilisateur a déjà écrit sa phrase au-dessus.

import { describe, it, expect } from 'vitest';
import {
  buildConversationThread,
  JOB_GONE_NOTE,
  STOPPED_ANSWER_NOTE,
  CUT_ANSWER_NOTE,
  UNCLASSIFIED_NOTE,
  olderTurnsNote,
} from '../conversation-thread.ts';
import type { ThreadAuditRow, ThreadJob } from '../conversation-thread.ts';
import type {
  ConversationFeed,
  DeliverySummary,
  FeedItem,
  FeedTotals,
  Step,
  TurnBlock,
  TurnUsage,
} from '../conversation-feed.ts';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { redactPresented } from '../redact-presented.ts';
import type { ProductionVerdict } from '../chat-or-work.ts';

const totals = (over: Partial<FeedTotals> = {}): FeedTotals => ({
  turns: 1,
  toolCalls: 0,
  inputTokens: 100,
  outputTokens: 10,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.01,
  llmDurationMs: 500,
  models: ['claude-opus-5'],
  ...over,
});

const chat: ProductionVerdict = {
  isWork: false,
  items: [],
  uncertain: 0,
  more: 0,
  unclassified: 0,
};
const travail: ProductionVerdict = {
  isWork: true,
  items: [{ kind: 'file', label: 'out/bilan.md', path: 'out/bilan.md' }],
  uncertain: 0,
  more: 0,
  unclassified: 0,
};

/** Un tour dont les lignes sont d'avant les cartes : on ne sait pas. */
const inconnu: ProductionVerdict = {
  isWork: false,
  items: [],
  uncertain: 0,
  more: 0,
  unclassified: 3,
};

const tour = (text: string): FeedItem => ({
  kind: 'turn',
  index: 1,
  turn: 1,
  turnSource: 'audit',
  agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
  model: 'claude-opus-5',
  at: null,
  blocks: [{ kind: 'prose', text }],
  usage: null,
});

/** Un fil de job tel que P2 le rend : un historique préfixé, la demande, un tour. */
const feedDeJob = (demande: string, reponse: string): ConversationFeed => ({
  items: [
    { kind: 'history', exchanges: [{ role: 'user', text: 'un tour plus ancien' }] },
    {
      kind: 'request',
      text: demande,
      origin: { channel: 'telegram', scheduleName: null, chatId: '4242' },
      at: null,
    },
    tour(reponse),
    { kind: 'answer', text: reponse },
  ],
  totals: totals(),
});

const job = (over: Partial<ThreadJob> & { jobId: string }): ThreadJob => ({
  feed: feedDeJob('fais ceci', 'voilà'),
  createdAt: null,
  completedAt: null,
  status: null,
  result: null,
  resultKind: null,
  verdict: chat,
  project: null,
  proof: [],
  repairs: 0,
  reviewVerdict: null,
  audit: [],
  workspaceRoots: [],
  ...over,
});

/**
 * Une ligne d'audit d'écriture (`file_write`), telle que `conversation-actions`
 * la range sous le job de tête — celle d'un délégué à n'importe quelle
 * profondeur. `output` : l'enveloppe écrite par executeTool.
 */
const ecriture = (
  path: string,
  content: string,
  output: string = '{"ok":true}',
): ThreadAuditRow => ({
  toolName: 'file_write',
  toolInput: { path, content },
  toolOutput: output,
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action: 'created' }] },
});

const conversation = {
  id: 'conv-1',
  channel: 'telegram',
  chatId: '4242',
  title: 'Un fil',
  agentName: 'Alfred',
  agentSlug: 'alfred',
  agentAvatarUrl: null,
  currentProject: null,
};

describe('buildConversationThread — une conversation de canal', () => {
  it('enchaîne les jobs dans l’ordre, SANS leur historique préfixé', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({ jobId: 'j1', feed: feedDeJob('premier', 'un') }),
        job({ jobId: 'j2', feed: feedDeJob('second', 'deux'), verdict: travail }),
      ],
    });

    expect(items.some((i) => i.kind === 'history')).toBe(false);
    // #135 / #132 — la RÉPONSE d'abord, le travail sous elle dans un groupe.
    expect(items.map((i) => i.kind)).toEqual([
      'request',
      'answer',
      'run',
      'request',
      'answer',
      'run',
      'produced',
    ]);
    const demandes = items.filter((i) => i.kind === 'request').map((i) => i.text);
    expect(demandes).toEqual(['premier', 'second']);
  });

  it('l’encart ne suit QUE le job qui a produit quelque chose', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({ jobId: 'j1' }),
        job({
          jobId: 'j2',
          verdict: travail,
          project: { id: 'p1', name: 'Bilans', path: '/w/bilans' },
        }),
      ],
    });
    const produits = items.filter((i) => i.kind === 'produced');
    expect(produits).toHaveLength(1);
    expect(produits[0]).toEqual({
      kind: 'produced',
      jobId: 'j2',
      status: null,
      verdict: travail,
      project: { id: 'p1', name: 'Bilans', path: '/w/bilans' },
      // P2bis — l'item porte de quoi dessiner le récapitulatif. Ce job n'a
      // ni preuve ni délégué : les champs le DISENT (null, []), ils ne
      // rendent pas un « 0 / 0 » ou un « $0.00 » qui n'existent pas.
      summary: {
        files: 0,
        fileChanges: [],
        lines: null,
        tests: null,
        durationMs: null,
        costUsd: 0.01,
        reviews: [],
        checks: [],
        verdict: null,
        // #375 — aucun tour de réparation : l'encart n'en dira rien.
        repairs: 0,
        // #59 — personne n'a relu ce travail : le récapitulatif le dit, et il
        // n'interdit rien.
        review: null,
        changesRequested: false,
        // #282 — ce travail n'a fait tourner aucune commande, et il a produit
        // quelque chose : la liste est vide et l'encart se dit une livraison.
        commands: [],
        produced: true,
        ended: null,
        live: null,
      },
    });
  });

  // #375 — le nombre de tours de réparation VOYAGE jusqu'à l'encart. Sans ce
  // cas, remplacer le transport par une constante laisserait la suite verte
  // (Reviewer C, PR #389).
  it('le nombre de réparations du travail arrive dans le récapitulatif', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ jobId: 'j3', verdict: travail, repairs: 1 })],
    });
    const produits = items.filter((i) => i.kind === 'produced');
    expect(produits).toHaveLength(1);
    expect(produits[0]?.kind === 'produced' ? produits[0].summary.repairs : null).toBe(1);
  });

  // ─── #282 ── une commande qu'on n'a pas vue se DIT ───────────────────
  //
  // Depuis #197 une commande dont aucune écriture n'est constatée sort
  // `certain: false` : elle ne décide plus qu'il y a eu travail, et elle est
  // comptée dans `uncertain`. Ce compte n'atteignait aucun écran — ni encart
  // (`isWork` est faux), ni note (`unclassified` est à zéro). Décision de
  // Quentin du 21/09 : l'encart, avec la commande marquée.

  /** Un tour dont la SEULE action est une commande dont rien n'a été vu. */
  const commandeNonConstatee: ProductionVerdict = {
    isWork: false,
    items: [
      {
        kind: 'command',
        label: 'ls -la',
        certain: false,
        purpose: null,
        exitCode: 0,
        timedOut: false,
        blocked: false,
      },
    ],
    uncertain: 1,
    more: 0,
    unclassified: 0,
  };

  it('l’encart paraît pour une commande dont rien n’a été constaté, et le dit', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ jobId: 'j1', verdict: commandeNonConstatee })],
    });
    const produits = items.filter((i) => i.kind === 'produced');
    expect(produits).toHaveLength(1);
    const e = produits[0] as Extract<FeedItem, { kind: 'produced' }>;
    // La commande est NOMMÉE, et marquée : c'est elle qu'on vient lire.
    expect(e.summary.commands).toEqual([
      {
        label: 'ls -la',
        observed: false,
        purpose: null,
        exitCode: 0,
        timedOut: false,
        blocked: false,
      },
    ]);
    // Et l'encart ne se dit PAS une livraison : le verdict n'a rien constaté,
    // et le mot de l'en-tête en dépend.
    expect(e.summary.produced).toBe(false);
    // Aucune note neutre à côté : l'encart et l'aveu ne paraissent jamais
    // ensemble, et c'est l'encart qui gagne ici.
    expect(items.filter((i) => i.kind === 'note')).toHaveLength(0);
  });

  it('une commande CONSTATÉE ne porte aucun aveu', () => {
    const constatee: ProductionVerdict = {
      isWork: true,
      items: [
        {
          kind: 'command',
          label: 'pnpm build',
          certain: true,
          purpose: null,
          exitCode: 0,
          timedOut: false,
          blocked: false,
        },
      ],
      uncertain: 0,
      more: 0,
      unclassified: 0,
    };
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ jobId: 'j1', verdict: constatee })],
    });
    const e = items.find((i) => i.kind === 'produced') as Extract<FeedItem, { kind: 'produced' }>;
    expect(e.summary.commands).toEqual([
      {
        label: 'pnpm build',
        observed: true,
        purpose: null,
        exitCode: 0,
        timedOut: false,
        blocked: false,
      },
    ]);
    expect(e.summary.produced).toBe(true);
  });

  // #372 — la phrase de l'agent ne s'arrête pas au verdict : elle descend
  // jusqu'au récapitulatif, qui est ce que l'écran lit.
  it('la phrase de l’agent descend du verdict jusqu’au récapitulatif', () => {
    const avecPhrase: ProductionVerdict = {
      isWork: true,
      items: [
        {
          kind: 'command',
          label: 'pnpm build',
          certain: true,
          purpose: 'Build before shipping',
          exitCode: 0,
          timedOut: false,
          blocked: false,
        },
      ],
      uncertain: 0,
      more: 0,
      unclassified: 0,
    };
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ jobId: 'j1', verdict: avecPhrase })],
    });
    const e = items.find((i) => i.kind === 'produced') as Extract<FeedItem, { kind: 'produced' }>;
    expect(e.summary.commands).toEqual([
      {
        label: 'pnpm build',
        observed: true,
        purpose: 'Build before shipping',
        exitCode: 0,
        timedOut: false,
        blocked: false,
      },
    ]);
  });

  it('un tour SANS commande et sans production ne rend toujours aucun encart', () => {
    const rien: ProductionVerdict = {
      isWork: false,
      items: [],
      uncertain: 0,
      more: 0,
      unclassified: 0,
    };
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ jobId: 'j1', verdict: rien })],
    });
    expect(items.filter((i) => i.kind === 'produced')).toHaveLength(0);
  });

  it('le récapitulatif compte un fichier UNE fois, quelle que soit son orthographe, et somme ses lignes', () => {
    // Vu en vrai le 07/09 : `file_write` présente le chemin absolu,
    // `file_edit` le chemin relatif — « 2 files » pour notes/bonjour.html.
    const absolu = 'C:\\Users\\q\\.nodalai\\workspaces\\shared\\notes\\bonjour.html';
    const edition: ThreadAuditRow = {
      toolName: 'file_edit',
      toolInput: { path: 'notes/bonjour.html', old_string: 'a', new_string: 'b\nc' },
      toolOutput: '{"ok":true}',
      presented: {
        card: 'files',
        total: 1,
        truncated: false,
        files: [{ path: 'notes/bonjour.html', action: 'modified' }],
      },
    };
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j2',
          verdict: travail,
          audit: [ecriture(absolu, Array.from({ length: 12 }, () => 'l').join('\n')), edition],
          // La racine connue : l'absolu se ramène à `notes/bonjour.html`.
          workspaceRoots: ['C:\\Users\\q\\.nodalai\\workspaces\\shared'],
        }),
      ],
    });
    const produit = items.find((i) => i.kind === 'produced');
    expect(produit?.kind === 'produced' && produit.summary.files).toBe(1);
    // #135 — la LISTE suit la même règle que le compte : le chemin canonique,
    // une seule fois, jamais la forme absolue à côté de la relative.
    expect(produit?.kind === 'produced' && produit.summary.fileChanges.map((f) => f.path)).toEqual([
      'notes/bonjour.html',
    ]);
    expect(produit?.kind === 'produced' && produit.summary.lines).toEqual({
      added: 14,
      removed: 1,
    });
  });

  it('`index.ts` à la racine et `a/index.ts` sont DEUX fichiers, même quand l’un est présenté en absolu (passe 57)', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j2',
          verdict: travail,
          audit: [ecriture('index.ts', 'x'), ecriture('/home/q/ws/a/index.ts', 'y')],
          workspaceRoots: ['/home/q/ws'],
        }),
      ],
    });
    const produit = items.find((i) => i.kind === 'produced');
    expect(produit?.kind === 'produced' && produit.summary.files).toBe(2);
  });

  it('les lignes d’audit de TOUTE la descendance comptent — pas seulement le fil assemblé (passe 56)', () => {
    // Le fil d'un petit-enfant n'est jamais assemblé (un niveau) ; sa ligne
    // d'audit, si. Ici le fil du job ne montre AUCUNE écriture : tout vient
    // de `audit`.
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j2',
          verdict: travail,
          audit: [ecriture('src/a.ts', 'x\ny\nz'), ecriture('src/b.ts', 'x')],
        }),
      ],
    });
    const produit = items.find((i) => i.kind === 'produced');
    expect(produit?.kind === 'produced' && produit.summary.files).toBe(2);
    expect(produit?.kind === 'produced' && produit.summary.lines).toEqual({ added: 4, removed: 0 });
  });

  it('une écriture qui n’a pas eu lieu (attente d’approbation, blocage, erreur) ne compte ni fichier ni ligne', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j2',
          verdict: travail,
          audit: [
            ecriture('src/a.ts', 'x\ny', '{"outcome":"awaiting_approval"}'),
            ecriture('src/b.ts', 'x', '{"outcome":"blocked"}'),
            ecriture('src/c.ts', 'x', '{"outcome":"error","error":"boom"}'),
          ],
        }),
      ],
    });
    const produit = items.find((i) => i.kind === 'produced');
    expect(produit?.kind === 'produced' && produit.summary.files).toBe(0);
    expect(produit?.kind === 'produced' && produit.summary.lines).toBeNull();
  });

  it('les totaux sont la somme des jobs, modèles dédupliqués', () => {
    const { totals: somme } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({ jobId: 'j1' }),
        job({
          jobId: 'j2',
          feed: {
            items: [],
            totals: totals({ inputTokens: 400, costUsd: 0.04, models: ['gpt-5', 'claude-opus-5'] }),
          },
        }),
      ],
    });
    expect(somme.inputTokens).toBe(500);
    expect(somme.costUsd).toBeCloseTo(0.05, 6);
    expect(somme.turns).toBe(2);
    expect([...somme.models].sort()).toEqual(['claude-opus-5', 'gpt-5']);
  });
});

describe('buildConversationThread — une conversation du dashboard', () => {
  const dashboard = { ...conversation, channel: 'dashboard', chatId: null };

  it('mêle les tours parlés et le travail escaladé, la demande devenant une consigne', () => {
    const { items } = buildConversationThread({
      conversation: dashboard,
      messages: [
        { id: 'm1', role: 'user', content: 'salut', jobId: null, createdAt: null },
        { id: 'm2', role: 'assistant', content: 'salut !', jobId: null, createdAt: null },
        { id: 'm3', role: 'user', content: 'fais le bilan', jobId: null, createdAt: null },
        {
          id: 'm4',
          role: 'assistant',
          content: 'je m’en occupe',
          jobId: 'j1',
          createdAt: new Date('2026-09-17T12:04:00Z'),
        },
      ],
      jobs: [
        job({
          jobId: 'j1',
          feed: feedDeJob('Produire le bilan mensuel dans out/', 'c’est fait'),
          verdict: travail,
        }),
      ],
    });

    expect(items.map((i) => i.kind)).toEqual([
      'request',
      'turn',
      'request',
      'turn',
      'handoff',
      'answer',
      'run',
      'produced',
    ]);
    const consigne = items.find((i) => i.kind === 'handoff');
    expect(consigne).toEqual({ kind: 'handoff', text: 'Produire le bilan mensuel dans out/' });
    // L'accusé du chat est bien un tour PARLÉ : ni modèle ni jetons inventés.
    // Son heure, en revanche, il l'a : un message de chat EST daté, et c'est
    // celle-là que l'en-tête montre (#135) — pas une date déduite d'une ligne
    // d'audit, que ce tour n'a pas.
    const accuse = items[3];
    expect(accuse).toMatchObject({
      kind: 'turn',
      turn: 0,
      turnSource: 'inferred',
      model: null,
      usage: null,
      at: new Date('2026-09-17T12:04:00Z'),
      blocks: [{ kind: 'prose', text: 'je m’en occupe' }],
    });
    expect(items.some((i) => i.kind === 'history')).toBe(false);
  });

  it('un tour escaladé SANS accusé ne fabrique pas de tour vide', () => {
    const { items } = buildConversationThread({
      conversation: dashboard,
      messages: [
        { id: 'm1', role: 'user', content: 'fais le bilan', jobId: null, createdAt: null },
        { id: 'm2', role: 'assistant', content: '', jobId: 'j1', createdAt: null },
      ],
      jobs: [job({ jobId: 'j1', feed: feedDeJob('bilan', 'fait') })],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'handoff', 'answer', 'run']);
  });

  it('un job purgé est DIT, jamais sauté en silence', () => {
    const { items } = buildConversationThread({
      conversation: dashboard,
      messages: [
        { id: 'm1', role: 'user', content: 'et hier ?', jobId: null, createdAt: null },
        { id: 'm2', role: 'assistant', content: 'je regarde', jobId: 'disparu', createdAt: null },
      ],
      jobs: [],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'turn', 'note']);
    expect(items[2]).toEqual({ kind: 'note', text: JOB_GONE_NOTE, origin: 'thread' });
  });

  it('une réponse arrêtée par la personne : ce qui était écrit, puis le fil le DIT (#456)', () => {
    const { items } = buildConversationThread({
      conversation: dashboard,
      messages: [
        { id: 'm1', role: 'user', content: 'une longue note', jobId: null, createdAt: null },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Le début de la note',
          jobId: null,
          createdAt: null,
          stopped: true,
        },
        { id: 'm3', role: 'user', content: 'autre chose', jobId: null, createdAt: null },
        { id: 'm4', role: 'assistant', content: 'voilà', jobId: null, createdAt: null },
      ],
      jobs: [],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'turn', 'note', 'request', 'turn']);
    expect(items[2]).toEqual({ kind: 'note', text: STOPPED_ANSWER_NOTE, origin: 'thread' });
  });

  it('arrêtée avant son premier mot : pas de tour vide, mais l’arrêt est dit', () => {
    const { items } = buildConversationThread({
      conversation: dashboard,
      messages: [
        { id: 'm1', role: 'user', content: 'une longue note', jobId: null, createdAt: null },
        { id: 'm2', role: 'assistant', content: '', jobId: null, createdAt: null, stopped: true },
      ],
      jobs: [],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'note']);
  });

  it('une réponse coupée par une horloge : ce qui était écrit, puis le fil le DIT (#458)', () => {
    const { items } = buildConversationThread({
      conversation: dashboard,
      messages: [
        { id: 'm1', role: 'user', content: 'la machine à vapeur', jobId: null, createdAt: null },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Le cylindre reçoit la vapeur',
          jobId: null,
          createdAt: null,
          cutReason: 'idle_between_tokens',
        },
        { id: 'm3', role: 'user', content: 'et ensuite ?', jobId: null, createdAt: null },
        { id: 'm4', role: 'assistant', content: 'voilà', jobId: null, createdAt: null },
      ],
      jobs: [],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'turn', 'note', 'request', 'turn']);
    expect(items[2]).toEqual({ kind: 'note', text: CUT_ANSWER_NOTE, origin: 'thread' });
  });
});

describe('buildConversationThread — ce que le fil ne peut pas dire', () => {
  const dashboard = { ...conversation, channel: 'dashboard', chatId: null };

  it("un tour d'avant les cartes est dit non classable — jamais un encart", () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ jobId: 'j1', verdict: inconnu })],
    });
    expect(items.some((i) => i.kind === 'produced')).toBe(false);
    const note = items.find((i) => i.kind === 'note');
    expect(note).toEqual({ kind: 'note', text: UNCLASSIFIED_NOTE, origin: 'thread' });
  });

  it("l'aveu d'ignorance paraît UNE fois par fil, pas une fois par job (P2bis)", () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({ jobId: 'j1', verdict: inconnu, feed: feedDeJob('un', 'a') }),
        job({ jobId: 'j2', verdict: inconnu, feed: feedDeJob('deux', 'b') }),
        job({ jobId: 'j3', verdict: inconnu, feed: feedDeJob('trois', 'c') }),
      ],
    });
    const notes = items.filter((i) => i.kind === 'note' && i.text === UNCLASSIFIED_NOTE);
    expect(notes).toHaveLength(1);
    // Et elle suit le PREMIER job concerné, pas le dernier.
    const rang = items.findIndex((i) => i.kind === 'note' && i.text === UNCLASSIFIED_NOTE);
    const rangDeux = items.findIndex((i) => i.kind === 'request' && i.text === 'deux');
    expect(rang).toBeLessThan(rangDeux);
  });

  it('deux notes consécutives de même texte n’en font qu’une', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j1',
          feed: {
            items: [
              { kind: 'note', text: 'Tu es sur Telegram.', origin: 'runner' },
              { kind: 'note', text: 'Tu es sur Telegram.', origin: 'runner' },
              { kind: 'note', text: 'Livre ta réponse.', origin: 'runner' },
            ],
            totals: totals(),
          },
        }),
      ],
    });
    expect(items.map((i) => (i.kind === 'note' ? i.text : i.kind))).toEqual([
      'Tu es sur Telegram.',
      'Livre ta réponse.',
    ]);
  });

  it('la compaction des tours muets vaut aussi pour le fil entier (P2bis)', () => {
    const muet = (): FeedItem => ({
      kind: 'turn',
      index: 2,
      turn: 2,
      turnSource: 'audit',
      agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
      model: 'claude-opus-5',
      // Un tour MUET n'a ni bloc ni ligne d'audit : il n'a donc pas d'heure,
      // et celle du tour qui l'absorbe reste la seule affichée (#135).
      at: null,
      blocks: [],
      usage: null,
    });
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j1',
          feed: { items: [tour('voilà'), muet(), muet()], totals: totals() },
        }),
      ],
    });
    // Le tour compacté vit maintenant DANS le groupe du run : la compaction se
    // fait donc AVANT le groupe, sans quoi elle ne verrait plus rien.
    const groupe = items.find((i) => i.kind === 'run');
    expect(items.filter((i) => i.kind === 'turn')).toHaveLength(0);
    expect(groupe?.kind === 'run' && groupe.items.filter((i) => i.kind === 'turn')).toHaveLength(1);
  });

  it('un tour qui a produit ET porte des lignes anciennes garde son encart, sans note', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ jobId: 'j1', verdict: { ...travail, unclassified: 2 } })],
    });
    expect(items.filter((i) => i.kind === 'produced')).toHaveLength(1);
    expect(items.some((i) => i.kind === 'note' && i.text === UNCLASSIFIED_NOTE)).toBe(false);
  });

  it('un tour ordinaire ne dit rien du tout', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ jobId: 'j1' })],
    });
    expect(items.some((i) => i.kind === 'note')).toBe(false);
  });

  it('une conversation de canal coupée le DIT en tête, avant tout item', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ jobId: 'j1' }), job({ jobId: 'j2' })],
      truncated: { messages: false, jobs: true },
    });
    expect(items[0]).toEqual({ kind: 'note', text: olderTurnsNote(2), origin: 'thread' });
    expect(items[1]?.kind).toBe('request');
  });

  it('une conversation du dashboard coupée compte ses MESSAGES', () => {
    const { items } = buildConversationThread({
      conversation: dashboard,
      messages: [
        { id: 'm1', role: 'user', content: 'a', jobId: null, createdAt: null },
        { id: 'm2', role: 'assistant', content: 'b', jobId: null, createdAt: null },
      ],
      jobs: [],
      truncated: { messages: true, jobs: false },
    });
    expect(items[0]).toEqual({ kind: 'note', text: olderTurnsNote(2), origin: 'thread' });
  });

  it('un fil entier ne parle pas de coupe', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ jobId: 'j1' })],
      truncated: { messages: false, jobs: false },
    });
    expect(items.some((i) => i.kind === 'note')).toBe(false);
  });
});

// ─── Le travail sous sa ligne de résumé (#135, #132) ─────────────────────────
//
// Le principe de Quentin : la réponse de l'agent d'abord, et sous elle UNE
// ligne qui résume le run. Ce qui se prouve ici est la STRUCTURE — ce qui sort
// du groupe, ce qui y reste, et ce que la ligne compte. L'écran est prouvé à
// côté (`RunSummaryRow.test.tsx`, `ConversationFeedView.test.tsx`).

const usage = (): TurnUsage => ({
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.02,
  durationMs: 1200,
  calls: 1,
});

const outil = (name: string): Extract<Step, { kind: 'tool' }> => ({
  kind: 'tool',
  toolName: name,
  toolCallId: `c-${name}`,
  jobId: 'j1',
  card: null,
  presented: null,
  input: {},
  outputText: null,
  outcome: 'success',
  durationMs: 40,
  lineCounts: {},
  question: null,
});

const tourDeTravail = (blocks: TurnBlock[]): FeedItem => ({
  kind: 'turn',
  index: 1,
  turn: 1,
  turnSource: 'audit',
  agent: { name: 'Agent One', slug: 'agent-one', avatarUrl: null },
  model: 'a-model',
  at: null,
  blocks,
  usage: usage(),
});

const delegue = (): FeedItem => ({
  kind: 'child',
  from: { name: 'Agent One', slug: 'agent-one', avatarUrl: null },
  job: {
    id: 'child-1',
    agentName: 'Agent Two',
    agentSlug: 'agent-two',
    agentAvatarUrl: null,
    status: 'completed',
    task: 'relire le bilan',
    result: 'rien à redire',
    error: null,
    failureHint: null,
    createdAt: null,
    completedAt: null,
  },
});

const demande: FeedItem = {
  kind: 'request',
  text: 'fais le bilan',
  origin: { channel: 'telegram', scheduleName: null, chatId: '4242' },
  at: null,
};

describe('buildConversationThread — le travail sous sa ligne de résumé', () => {
  const travailFini = (): ThreadJob =>
    job({
      jobId: 'j1',
      createdAt: new Date('2026-09-17T12:00:00Z'),
      completedAt: new Date('2026-09-17T12:00:12Z'),
      feed: {
        items: [
          demande,
          tourDeTravail([
            { kind: 'prose', text: 'Je commence par lire les notes.' },
            { kind: 'steps', steps: [outil('file_read'), outil('file_search')] },
          ]),
          tourDeTravail([{ kind: 'prose', text: 'Voilà le bilan.' }]),
          delegue(),
        ],
        totals: totals({ toolCalls: 3, costUsd: 0.04 }),
      },
    });

  it('groupe le travail en UN item, après la réponse', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [travailFini()],
    });
    // La réponse sortie du groupe reste un TOUR : c'est l'agent qui parle, avec
    // son nom, son image et son heure — une plaque anonyme les perdrait.
    expect(items.map((i) => i.kind)).toEqual(['request', 'turn', 'run']);
  });

  it('la dernière prose du dernier tour SORT du groupe ; une prose intermédiaire y reste', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [travailFini()],
    });
    const reponse = items[1];
    expect(reponse?.kind === 'turn' && reponse.blocks).toEqual([
      { kind: 'prose', text: 'Voilà le bilan.' },
    ]);
    // Le tour sorti ne porte NI jetons NI durée : sa ligne de modèle reste dans
    // le groupe, avec le travail qu'elle a payé.
    expect(reponse?.kind === 'turn' && reponse.usage).toBeNull();

    const groupe = items[2];
    if (groupe?.kind !== 'run') throw new Error('le fil n’a pas posé de groupe de run');
    const proses = groupe.items.flatMap((i) =>
      i.kind === 'turn' ? i.blocks.filter((b) => b.kind === 'prose').map((b) => b.text) : [],
    );
    expect(proses).toEqual(['Je commence par lire les notes.']);
    expect(groupe.items.map((i) => i.kind)).toEqual(['turn', 'turn', 'child']);
  });

  it('quand la dernière prose EST ce que le travail a rendu, le tour sort du groupe, sans doublon', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ ...travailFini(), result: 'Voilà le bilan.' })],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'turn', 'run']);
    const reponse = items[1];
    expect(reponse?.kind === 'turn' && reponse.blocks).toEqual([
      { kind: 'prose', text: 'Voilà le bilan.' },
    ]);
    const groupe = items[2];
    if (groupe?.kind !== 'run') throw new Error('le fil n’a pas posé de groupe de run');
    const proses = groupe.items.flatMap((i) =>
      i.kind === 'turn' ? i.blocks.filter((b) => b.kind === 'prose').map((b) => b.text) : [],
    );
    expect(proses).toEqual(['Je commence par lire les notes.']);
  });

  it('quand la dernière prose n’est qu’une annonce, ce qu’on lit dehors est ce que le travail a RENDU', () => {
    // Le cas vu par Quentin (18/09) : l'agent publie sa réponse par une carte
    // d'envoi, puis rend son résultat ; sa dernière phrase dit « je publie ».
    // Sortir cette phrase cachait la vraie réponse dans le groupe replié.
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j1',
          createdAt: new Date('2026-09-17T12:00:00Z'),
          completedAt: new Date('2026-09-17T12:00:12Z'),
          result: '# Revue\n\nTrois constats, aucun bloquant.',
          feed: {
            items: [
              demande,
              tourDeTravail([
                { kind: 'prose', text: 'Je lis la PR.' },
                { kind: 'steps', steps: [outil('file_read')] },
              ]),
              tourDeTravail([
                { kind: 'prose', text: 'Je publie la revue sur le dashboard.' },
                { kind: 'steps', steps: [outil('dashboard_publish')] },
              ]),
            ],
            totals: totals({ toolCalls: 2, costUsd: 0.02 }),
          },
        }),
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'answer', 'run']);
    expect(items[1]).toEqual({
      kind: 'answer',
      text: '# Revue\n\nTrois constats, aucun bloquant.',
    });
    // L'annonce et la carte restent dans le groupe, où le dépliage les montre.
    const groupe = items[2];
    if (groupe?.kind !== 'run') throw new Error('le fil n’a pas posé de groupe de run');
    const proses = groupe.items.flatMap((i) =>
      i.kind === 'turn' ? i.blocks.filter((b) => b.kind === 'prose').map((b) => b.text) : [],
    );
    expect(proses).toEqual(['Je lis la PR.', 'Je publie la revue sur le dashboard.']);
  });

  it('un travail qui court ne sort rien : sa dernière phrase est une étape, pas une réponse', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ ...travailFini(), completedAt: null, result: 'Voilà le bilan.' })],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'run']);
  });

  // La provenance LUE sur la ligne, plutôt que devinée au premier caractère
  // (#154). Le fil montre alors la bonne chose : c'est un fait d'écran.
  describe('la provenance du résultat @cap:suivre-execution/ecran', () => {
    it('un résultat machine (du JSON) ne sort pas brut : la dernière prose reste la réponse', () => {
      // Reviewer C, passe 1 : un résultat structuré sorti tel quel cachait la
      // vraie réponse, repliée. Depuis #154 l'heuristique du premier caractère
      // ne tourne plus que sur un travail fini AVANT la colonne `result_kind` :
      // c'est ce repli-là que ce test tient, et il est DIT, pas silencieux.
      const { items } = buildConversationThread({
        conversation,
        messages: [],
        jobs: [job({ ...travailFini(), result: '{"files": 3, "ok": true}', resultKind: null })],
      });
      expect(items.map((i) => i.kind)).toEqual(['request', 'turn', 'run']);
      const reponse = items[1];
      expect(reponse?.kind === 'turn' && reponse.blocks).toEqual([
        { kind: 'prose', text: 'Voilà le bilan.' },
      ]);
    });

    it('marqué prose, un résultat en JSON lisible EST la réponse (#154)', () => {
      // LE TROU QUE #154 FERME. L'agent a publié sa réponse sous forme de
      // tableau JSON, puis annoncé qu'il la publiait. L'heuristique refusait la
      // réponse et montrait l'annonce ; la marque dit que ce texte est le sien.
      const { items } = buildConversationThread({
        conversation,
        messages: [],
        jobs: [
          job({
            jobId: 'j1',
            createdAt: new Date('2026-09-17T12:00:00Z'),
            completedAt: new Date('2026-09-17T12:00:12Z'),
            result: '["3 constats, aucun bloquant"]',
            resultKind: 'prose',
            feed: {
              items: [
                demande,
                tourDeTravail([
                  { kind: 'prose', text: 'Je publie la revue sur le dashboard.' },
                  { kind: 'steps', steps: [outil('dashboard_publish')] },
                ]),
              ],
              totals: totals({ toolCalls: 1, costUsd: 0.01 }),
            },
          }),
        ],
      });
      expect(items.map((i) => i.kind)).toEqual(['request', 'answer', 'run']);
      expect(items[1]).toEqual({ kind: 'answer', text: '["3 constats, aucun bloquant"]' });
    });

    it('marqué relay, le texte des délégués sort aussi : c’est ce qui a été livré', () => {
      // `relay` dit d'où vient le texte, pas qu'il faut le cacher. Dans le fil,
      // c'est ce que la personne a reçu. La distinction sert à la page d'un run,
      // où le bloc Review porte déjà ce rapport (#210).
      const compile = '## alfred\nTrois constats.\n\n---\n\n## reviewer\nAucun bloquant.';
      const { items } = buildConversationThread({
        conversation,
        messages: [],
        jobs: [
          job({
            jobId: 'j1',
            createdAt: new Date('2026-09-17T12:00:00Z'),
            completedAt: new Date('2026-09-17T12:00:12Z'),
            result: compile,
            resultKind: 'relay',
            feed: {
              items: [demande, tourDeTravail([{ kind: 'prose', text: 'Je délègue la revue.' }])],
              totals: totals(),
            },
          }),
        ],
      });
      expect(items.map((i) => i.kind)).toEqual(['request', 'answer', 'run']);
      expect(items[1]).toEqual({ kind: 'answer', text: compile });
    });

    it('marqué prose, un résultat égal à la prose ne la double pas', () => {
      // La marque ne remplace QUE le reniflage du premier caractère. Les deux
      // autres refus — même phrase, début tronqué — sont d'une autre nature :
      // ils évitent un doublon, pas une méprise sur le genre du texte.
      const { items } = buildConversationThread({
        conversation,
        messages: [],
        jobs: [job({ ...travailFini(), result: 'Voilà le bilan.', resultKind: 'prose' })],
      });
      expect(items.map((i) => i.kind)).toEqual(['request', 'turn', 'run']);
      const reponse = items[1];
      expect(reponse?.kind === 'turn' && reponse.blocks).toEqual([
        { kind: 'prose', text: 'Voilà le bilan.' },
      ]);
    });
  });

  it('un résultat qui n’est qu’un début tronqué de la prose ne la remplace pas', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [job({ ...travailFini(), result: 'Voilà le…' })],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'turn', 'run']);
  });

  it('une note du runner reste entre la demande et la réponse, hors du groupe', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j1',
          createdAt: new Date('2026-09-17T12:00:00Z'),
          completedAt: new Date('2026-09-17T12:00:12Z'),
          result: 'Voilà le bilan.',
          feed: {
            items: [
              demande,
              { kind: 'note', text: 'Le runner rappelle la consigne.', origin: 'runner' },
              tourDeTravail([{ kind: 'prose', text: 'Voilà le bilan.' }]),
            ],
            totals: totals(),
          },
        }),
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'note', 'turn', 'run']);
  });

  it('la ligne compte aussi le travail d’un délégué dont le fil est dans le groupe', () => {
    const delegueAvecFil: FeedItem = {
      ...delegue(),
      job: {
        ...(delegue() as Extract<FeedItem, { kind: 'child' }>).job,
        feed: { items: [], totals: totals({ toolCalls: 2, costUsd: 0.01 }) },
      },
    } as FeedItem;
    const fini = travailFini();
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          ...fini,
          feed: {
            items: fini.feed.items.map((i) => (i.kind === 'child' ? delegueAvecFil : i)),
            totals: fini.feed.totals,
          },
        }),
      ],
    });
    const groupe = items.find((i) => i.kind === 'run');
    // 3 outils du job + 2 du délégué ; 0.04 $ + 0.01 $.
    expect(groupe?.kind === 'run' && groupe.summary.tools).toBe(5);
    expect(groupe?.kind === 'run' && groupe.summary.costUsd).toBeCloseTo(0.05, 6);
    expect(groupe?.kind === 'run' && groupe.summary.delegations).toBe(1);
  });

  it('la ligne compte ce que le dépliage montre : outils, délégations, appels de modèle', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [travailFini()],
    });
    const groupe = items.find((i) => i.kind === 'run');
    expect(groupe?.kind === 'run' && groupe.summary).toEqual({
      tools: 3,
      delegations: 1,
      modelCalls: 2,
      durationMs: 12_000,
      costUsd: 0.04,
    });
  });

  it('une durée et un coût inconnus restent null — jamais un zéro', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j1',
          feed: {
            items: [demande, tourDeTravail([{ kind: 'steps', steps: [outil('file_read')] }])],
            totals: totals({ toolCalls: 1, costUsd: null }),
          },
        }),
      ],
    });
    const groupe = items.find((i) => i.kind === 'run');
    expect(groupe?.kind === 'run' && groupe.summary.durationMs).toBeNull();
    expect(groupe?.kind === 'run' && groupe.summary.costUsd).toBeNull();
  });

  it('un job qui porte un item `answer` le garde DEHORS, et tout son travail dedans', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j1',
          createdAt: new Date('2026-09-17T12:00:00Z'),
          completedAt: new Date('2026-09-17T12:00:12Z'),
          feed: {
            items: [
              demande,
              tourDeTravail([{ kind: 'steps', steps: [outil('file_write')] }]),
              { kind: 'answer', text: 'Le bilan est écrit.' },
            ],
            totals: totals({ toolCalls: 1 }),
          },
        }),
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'answer', 'run']);
    expect(items[1]).toEqual({ kind: 'answer', text: 'Le bilan est écrit.' });
    const groupe = items[2];
    expect(groupe?.kind === 'run' && groupe.items.map((i) => i.kind)).toEqual(['turn']);
  });

  it('un travail ÉCHOUÉ garde son échec dehors, APRÈS le groupe — et sa dernière phrase dedans', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j1',
          createdAt: new Date('2026-09-17T12:00:00Z'),
          completedAt: new Date('2026-09-17T12:00:05Z'),
          feed: {
            items: [
              demande,
              tourDeTravail([{ kind: 'prose', text: 'Je tente autre chose.' }]),
              { kind: 'failure', text: 'le dossier est introuvable', hint: null },
            ],
            totals: totals({ toolCalls: 0 }),
          },
        }),
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'run', 'failure']);
    const groupe = items[1];
    expect(
      groupe?.kind === 'run' &&
        groupe.items.some((i) => i.kind === 'turn' && i.blocks.some((b) => b.kind === 'prose')),
    ).toBe(true);
  });

  it('un travail QUI COURT ne fabrique pas de réponse : sa dernière phrase reste dans le groupe', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j1',
          createdAt: new Date('2026-09-17T12:00:00Z'),
          completedAt: null,
          feed: {
            items: [demande, tourDeTravail([{ kind: 'prose', text: 'Je regarde le dossier.' }])],
            totals: totals({ toolCalls: 0 }),
          },
        }),
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'run']);
  });

  it('un job de pure conversation n’a AUCUN groupe — il n’y a pas de travail à replier', () => {
    const { items } = buildConversationThread({
      conversation,
      messages: [],
      jobs: [
        job({
          jobId: 'j1',
          createdAt: new Date('2026-09-17T12:00:00Z'),
          completedAt: new Date('2026-09-17T12:00:01Z'),
          feed: {
            items: [demande, tourDeTravail([{ kind: 'prose', text: 'Bonjour.' }])],
            totals: totals({ toolCalls: 0 }),
          },
        }),
      ],
    });
    // Le tour qui ne fait que parler garde son appel de modèle : sa prose est
    // sortie, mais sa ligne de modèle reste — donc un groupe d'UN item.
    expect(items.map((i) => i.kind)).toEqual(['request', 'turn', 'run']);
    const groupe = items[2];
    expect(groupe?.kind === 'run' && groupe.summary.modelCalls).toBe(1);
    expect(groupe?.kind === 'run' && groupe.summary.tools).toBe(0);
  });
});

// Jetons factices, de la forme que le masqueur reconnaît — aucun n'a jamais
// existé. Deux fichiers nommés d'après eux masquent vers le MÊME chemin.
const CLE_A = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // secrets:allow (fixture)
const CLE_B = 'sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210'; // secrets:allow (fixture)

/**
 * Une ligne d'audit telle que `conversation-actions` la range sous le job de
 * tête : la carte MASQUÉE, et les chemins d'avant masquage à côté.
 */
const ecritureMasquee = (path: string): ThreadAuditRow => {
  const carte = {
    card: 'files',
    total: 1,
    truncated: false,
    files: [{ path, action: 'created' }],
  };
  return {
    toolName: 'file_write',
    toolInput: { path, content: 'x' },
    toolOutput: '{"ok":true}',
    presented: redactPresented(carte),
    rawFilePaths: [path],
  };
};

const recapDe = (audit: readonly ThreadAuditRow[]): DeliverySummary => {
  const { items } = buildConversationThread({
    conversation,
    messages: [],
    jobs: [job({ jobId: 'j-secret', verdict: travail, audit: [...audit] })],
  });
  const produit = items.find((i) => i.kind === 'produced');
  if (produit?.kind !== 'produced') throw new Error('aucun encart de livraison');
  return produit.summary;
};

describe('récapitulatif de livraison — un chemin masqué n’efface pas un fichier @cap:suivre-execution/moteur', () => {
  it('compte DEUX fichiers dont les chemins ne diffèrent que par un jeton, et les montre masqués', () => {
    // #161 : la carte entre dans le fil déjà masquée (#150), donc les deux
    // chemins y sont devenus identiques. L'identité reste le chemin brut.
    const recap = recapDe([
      ecritureMasquee(`cles/${CLE_A}.txt`),
      ecritureMasquee(`cles/${CLE_B}.txt`),
    ]);
    expect(recap.files).toBe(2);
    expect(recap.fileChanges.map((f) => f.path)).toEqual([
      `cles/${REDACTED_TEXT} (sk-).txt`,
      `cles/${REDACTED_TEXT} (sk-).txt`,
    ]);
  });

  it('AUCUN chemin brut n’arrive dans la liste affichée', () => {
    const recap = recapDe([
      ecritureMasquee(`cles/${CLE_A}.txt`),
      ecritureMasquee(`cles/${CLE_B}.txt`),
    ]);
    const affiche = recap.fileChanges.map((f) => f.path).join('\n');
    expect(affiche).not.toContain(CLE_A);
    expect(affiche).not.toContain(CLE_B);
    expect(affiche).toContain(REDACTED_TEXT);
  });

  it('le MÊME fichier écrit deux fois compte une seule fois, jeton ou pas', () => {
    const recap = recapDe([
      ecritureMasquee(`cles/${CLE_A}.txt`),
      ecritureMasquee(`cles/${CLE_A}.txt`),
    ]);
    expect(recap.files).toBe(1);
    expect(recap.fileChanges.map((f) => f.path)).toEqual([`cles/${REDACTED_TEXT} (sk-).txt`]);
  });

  it('une ligne SANS chemins bruts garde l’ancienne identité : le chemin présenté', () => {
    // Une ligne construite ailleurs (ou d'avant #161) n'a pas `rawFilePaths` :
    // deux chemins présentés différents restent deux fichiers.
    const sansBruts = (path: string): ThreadAuditRow => ({
      toolName: 'file_write',
      toolInput: { path, content: 'x' },
      toolOutput: '{"ok":true}',
      presented: {
        card: 'files',
        total: 1,
        truncated: false,
        files: [{ path, action: 'created' }],
      },
    });
    const recap = recapDe([sansBruts('src/a.ts'), sansBruts('src/b.ts')]);
    expect(recap.files).toBe(2);
    expect(recap.fileChanges.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
