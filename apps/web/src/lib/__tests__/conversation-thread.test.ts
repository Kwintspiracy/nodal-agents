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
  UNCLASSIFIED_NOTE,
  olderTurnsNote,
} from '../conversation-thread.ts';
import type { ThreadJob } from '../conversation-thread.ts';
import type { ConversationFeed, FeedItem, FeedTotals } from '../conversation-feed.ts';
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
  agent: { name: 'Alfred', slug: 'alfred' },
  model: 'claude-opus-5',
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
  verdict: chat,
  project: null,
  ...over,
});

const conversation = {
  id: 'conv-1',
  channel: 'telegram',
  chatId: '4242',
  title: 'Un fil',
  agentName: 'Alfred',
  agentSlug: 'alfred',
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
    expect(items.map((i) => i.kind)).toEqual([
      'request',
      'turn',
      'answer',
      'request',
      'turn',
      'answer',
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
      verdict: travail,
      project: { id: 'p1', name: 'Bilans', path: '/w/bilans' },
    });
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
        { id: 'm4', role: 'assistant', content: 'je m’en occupe', jobId: 'j1', createdAt: null },
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
      'turn',
      'answer',
      'produced',
    ]);
    const consigne = items.find((i) => i.kind === 'handoff');
    expect(consigne).toEqual({ kind: 'handoff', text: 'Produire le bilan mensuel dans out/' });
    // L'accusé du chat est bien un tour PARLÉ : ni modèle ni jetons inventés.
    const accuse = items[3];
    expect(accuse).toMatchObject({
      kind: 'turn',
      turn: 0,
      turnSource: 'inferred',
      model: null,
      usage: null,
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
    expect(items.map((i) => i.kind)).toEqual(['request', 'handoff', 'turn', 'answer']);
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
    expect(items[2]).toEqual({ kind: 'note', text: JOB_GONE_NOTE });
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
    expect(note).toEqual({ kind: 'note', text: UNCLASSIFIED_NOTE });
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
    expect(items[0]).toEqual({ kind: 'note', text: olderTurnsNote(2) });
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
    expect(items[0]).toEqual({ kind: 'note', text: olderTurnsNote(2) });
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
