// conversation-feed-handoff-note.test.ts — la note de l'agent qui remet une
// demande (handoff.ts) se montre à la personne COMME LA SIENNE : un item à
// part, sans le cadre écrit pour le modèle, jamais comme un rappel de la
// plateforme ni comme les mots de la personne.
//
// Les messages viennent des producteurs RÉELS : `openingMessages` (l'ouverture
// d'un job, la relance d'une file) et `inboxMessages` (ce qu'un tour de
// réponse transmet à un travail en cours).
//
// L'HISTORIQUE que le job reçoit désormais sur le tableau de bord comme sur
// tout canal (thread-history.ts) ne se montre pas comme de nouveaux messages :
// le fil du run le replie dans un groupe d'historique (frontière : le message
// égal à la tâche), et le fil de la conversation ne le montre pas du tout —
// ses tours y sont déjà, une fois chacun.
//
// Mutations vérifiées : la détection de la note retirée du constructeur du fil
// (`handoffNoteOf`) → les cas de la note rougissent (elle devient un « rappel »
// encadré) ; la frontière de l'historique ignorée (`lastIndexOfTask` qui rend
// 0) → les cas de l'historique rougissent (le premier message redevient la
// demande, la correction un rappel).

import { describe, it, expect } from 'vitest';
import { HANDOFF_NOTE_FRAME, inboxMessages, openingMessages } from '@nodal-agents/shared';
import { buildConversationFeed, type FeedJob } from '../conversation-feed.ts';
import { buildConversationThread, type ThreadJob } from '../conversation-thread.ts';

const at = (s: string) => new Date(s);

function jobWith(task: string, messages: unknown[]): FeedJob {
  return {
    id: '0b6a4f7e-6d0c-4a7e-9a59-2f3cc1a0f001',
    task,
    channel: 'dashboard',
    chatId: null,
    status: 'completed',
    result: 'Voici la feuille.',
    error: null,
    failureHint: null,
    agentName: 'Alfred',
    agentSlug: 'alfred',
    agentAvatarUrl: null,
    createdAt: at('2026-10-18T03:23:40.000Z'),
    completedAt: at('2026-10-18T03:30:00.000Z'),
    messages,
    scheduleName: null,
    children: [],
  } as FeedJob;
}

const WORDS = 'Les chiffres doivent se tracer en un seul trait.';
const NOTE = 'Rien n’est imprimé avant son accord.';

describe('the relaying agent’s note is shown as its own, never framed for the model @cap:parler-a-un-agent/ecran', () => {
  it('a job’s opening: the person’s words are the request, the note an item of its own, without the frame', () => {
    const feed = buildConversationFeed(
      jobWith(WORDS, [
        ...openingMessages(WORDS, NOTE),
        { role: 'assistant', content: 'Voici la feuille.' },
      ]),
      [],
      [],
    );

    const lead = feed.items.filter((i) => i.kind === 'request' || i.kind === 'handoff-note');
    expect(lead.map((i) => [i.kind, 'text' in i ? i.text : null])).toEqual([
      ['request', WORDS],
      ['handoff-note', NOTE],
    ]);
    expect(feed.items.some((i) => i.kind === 'note')).toBe(false);
    expect(JSON.stringify(feed.items)).not.toContain(HANDOFF_NOTE_FRAME);
  });

  it('a message passed on while the work runs: its note is the agent’s, not a reminder of the platform', () => {
    const feed = buildConversationFeed(
      jobWith('Fais-moi une feuille.', [
        { role: 'user', content: 'Fais-moi une feuille.' },
        { role: 'assistant', content: 'Je prépare la feuille.' },
        ...inboxMessages({
          id: 'e1',
          task: WORDS,
          content: WORDS,
          receivedAt: '2026-10-18T03:23:32.000Z',
          note: NOTE,
        }),
        { role: 'assistant', content: 'Voici la feuille.' },
      ]),
      [],
      [],
    );

    expect(feed.items.filter((i) => i.kind === 'handoff-note')).toEqual([
      { kind: 'handoff-note', text: NOTE },
    ]);
    expect(JSON.stringify(feed.items)).not.toContain(HANDOFF_NOTE_FRAME);
  });

  it('a dashboard job’s replayed history: folded on the run page, absent from the thread, never new messages', () => {
    const REQUEST = 'Fais-moi une feuille, avant de l’imprimer.';
    // Ce que thread-history.ts prépose, puis l'ouverture du job.
    const transcript = [
      { role: 'user', content: `[Sun, 18 Oct 2026, 05:14] ${REQUEST}` },
      { role: 'assistant', content: 'Je lance la proposition.\n\nVoici la proposition.' },
      ...openingMessages(WORDS, NOTE),
      { role: 'assistant', content: 'Voici la feuille.' },
    ];
    const feed = buildConversationFeed(jobWith(WORDS, transcript), [], []);

    // La page du run : un seul groupe d'historique, puis la demande et la note.
    expect(feed.items.filter((i) => i.kind === 'history')).toHaveLength(1);
    expect(feed.items.filter((i) => i.kind === 'request').map((i) => i.text)).toEqual([WORDS]);
    expect(feed.items.some((i) => i.kind === 'note')).toBe(false);

    // Le fil de la conversation : chaque message de la personne une fois, le
    // sien ; ce qui a été passé au travail et la note de l'agent, à part.
    const job = {
      jobId: 'j2',
      feed,
      createdAt: null,
      completedAt: null,
      status: 'completed',
      result: 'Voici la feuille.',
      resultKind: 'prose',
      verdict: { isWork: false, items: [], uncertain: 0, more: 0, unclassified: 0 },
      project: null,
      proof: [],
      repairs: 0,
      declaredUnverified: [],
      reviewVerdict: null,
      audit: [],
      cost: { costUsd: null, unpricedCalls: 0 },
      workspaceRoots: [],
    } as unknown as ThreadJob;
    const thread = buildConversationThread({
      conversation: {
        id: 'conv-1',
        channel: 'dashboard',
        chatId: null,
        title: 'Feuille',
        agentName: 'Alfred',
        agentSlug: 'alfred',
        agentAvatarUrl: null,
        currentProject: null,
      },
      messages: [
        { id: 'm1', role: 'user', content: REQUEST, jobId: null, createdAt: null },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Voici une proposition.',
          jobId: null,
          createdAt: null,
        },
        { id: 'm3', role: 'user', content: WORDS, jobId: null, createdAt: null },
        { id: 'm4', role: 'assistant', content: 'Je corrige.', jobId: 'j2', createdAt: null },
      ],
      jobs: [job],
    });
    const texts = JSON.stringify(thread.items);
    expect(thread.items.some((i) => i.kind === 'history')).toBe(false);
    expect(thread.items.filter((i) => i.kind === 'request').map((i) => i.text)).toEqual([
      REQUEST,
      WORDS,
    ]);
    expect(texts.split(REQUEST).length - 1).toBe(1);
    expect(thread.items.filter((i) => i.kind === 'handoff-note')).toEqual([
      { kind: 'handoff-note', text: NOTE },
    ]);
    expect(texts).not.toContain(HANDOFF_NOTE_FRAME);
  });
});
