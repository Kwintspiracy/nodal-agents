// conversation-feed-handoff-note.test.ts — la note de l'agent qui remet une
// demande (handoff.ts) se montre à la personne COMME LA SIENNE : un item à
// part, sans le cadre écrit pour le modèle, jamais comme un rappel de la
// plateforme ni comme les mots de la personne.
//
// Les messages viennent des producteurs RÉELS : `openingMessages` (l'ouverture
// d'un job, la relance d'une file) et `inboxMessages` (ce qu'un tour de
// réponse transmet à un travail en cours).
//
// Mutation vérifiée : la détection de la note retirée du constructeur du fil
// (`handoffNoteOf`) → les deux cas rougissent (la note devient un « rappel »
// encadré).

import { describe, it, expect } from 'vitest';
import { HANDOFF_NOTE_FRAME, inboxMessages, openingMessages } from '@nodal-agents/shared';
import { buildConversationFeed, type FeedJob } from '../conversation-feed.ts';

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
});
