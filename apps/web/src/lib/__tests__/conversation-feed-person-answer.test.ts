// conversation-feed-person-answer.test.ts — le relevé que le runner pose pour
// l'agent après une question d'un serveur (#1084) ne se montre JAMAIS comme
// un message que la personne aurait tapé : sur le fil d'un run, c'est une
// note de la plateforme, comme ses autres messages posés après un appel.
//
// Le message vient du producteur RÉEL (`personAnswerMessage`).
//
// Mutation vérifiée : le fil qui prend tout message utilisateur pour une
// demande (la branche `sawRequest` forcée à faux) → ce cas rougit.

import { describe, it, expect } from 'vitest';
import { personAnswerMessage } from '@nodal-agents/shared';
import { buildConversationFeed, type FeedJob } from '../conversation-feed.ts';

const at = (s: string) => new Date(s);
const TASK = 'Fais relire la page.';

function jobWith(messages: unknown[]): FeedJob {
  return {
    id: '0b6a4f7e-6d0c-4a7e-9a59-2f3cc1a0f084',
    task: TASK,
    channel: 'dashboard',
    chatId: null,
    status: 'completed',
    result: 'Je raccourcis la page.',
    error: null,
    failureHint: null,
    agentName: 'Alfred',
    agentSlug: 'alfred',
    agentAvatarUrl: null,
    createdAt: at('2026-11-14T15:00:00.000Z'),
    completedAt: at('2026-11-14T15:10:00.000Z'),
    messages,
    scheduleName: null,
    children: [],
  } as FeedJob;
}

describe('le relevé de la réponse à un serveur n’est pas un message de la personne sur le fil @cap:approuver-une-action/ecran', () => {
  it('la demande reste la tâche ; le relevé est une note de la plateforme', () => {
    const record = personAnswerMessage({
      id: '00000000-0000-4000-8000-0000000010e4',
      toolName: 'reviewdesk__order',
      toolCallId: 'call-ask',
      toolInput: { actions: { decline: 'Cancel' } },
      status: 'rejected',
      response: null,
      notes: 'make it shorter',
      resolvedAt: at('2026-11-14T15:08:00.000Z'),
      resolvedBy: 'api',
    });
    const feed = buildConversationFeed(
      jobWith([
        { role: 'user', content: TASK },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'call-ask', toolName: 'reviewdesk__order', input: {} },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-ask',
              toolName: 'reviewdesk__order',
              output: { type: 'text', value: '{"action":"decline","content":null}' },
            },
          ],
        },
        record,
        { role: 'assistant', content: 'Je raccourcis la page.' },
      ]),
      [],
      [],
    );

    const requests = feed.items.filter((i) => i.kind === 'request');
    expect(requests.map((i) => ('text' in i ? i.text : null))).toEqual([TASK]);
    const notes = feed.items.filter((i) => i.kind === 'note');
    expect(notes).toEqual([
      expect.objectContaining({ kind: 'note', origin: 'runner', text: record.content }),
    ]);
  });
});
