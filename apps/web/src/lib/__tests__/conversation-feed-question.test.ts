// conversation-feed-question.test.ts — une QUESTION dans le fil (P10a), et le
// dédoublonnage des lignes d'audit d'un appel rejoué.
//
// Deux règles sont protégées ici :
//   1. une question EN ATTENTE se montre seule, alors même que son appel n'a pas
//      réussi — c'est le seul cas où l'échec est justement ce qu'il faut montrer,
//      puisque c'est là que les boutons doivent apparaître ;
//   2. un appel APPROUVÉ laisse DEUX lignes `tool_calls` avec le même
//      `tool_call_id` (la suspension, puis la reprise). Le fil n'en fait qu'UNE
//      étape, celle de la DERNIÈRE ligne. Ce n'est pas propre aux questions :
//      tout outil approuvé produit ces deux lignes.

import { describe, it, expect } from 'vitest';
import {
  buildConversationFeed,
  showsAlone,
  type FeedJob,
  type FeedToolCallRow,
  type FeedQuestionRow,
  type Step,
  type TurnBlock,
} from '../conversation-feed.ts';

const QUESTION = 'Where should I write the summary?';
const OPTIONS = ['The repo README', 'A new file in notes'];
const CALL_ID = 'call_ask';

const job = (): FeedJob => ({
  id: 'job-1',
  task: 'write a summary',
  channel: 'dashboard',
  chatId: null,
  status: 'awaiting_approval',
  result: null,
  error: null,
  agentName: 'Alfred',
  agentSlug: 'alfred',
  createdAt: new Date('2026-09-06T10:00:00Z'),
  completedAt: null,
  messages: [
    { role: 'user', content: 'write a summary' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: CALL_ID,
          toolName: 'ask_user',
          input: { question: QUESTION, options: OPTIONS },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: CALL_ID,
          toolName: 'ask_user',
          output: { type: 'text', value: '[AWAITING_APPROVAL] tool_call_id=call_ask' },
        },
      ],
    },
  ],
  scheduleName: null,
  children: [],
});

const suspendedRow = (): FeedToolCallRow => ({
  toolCallId: CALL_ID,
  toolName: 'ask_user',
  card: 'question',
  presented: null,
  durationMs: 4,
  turn: 1,
  toolInput: { question: QUESTION, options: OPTIONS },
  toolOutput: JSON.stringify({ outcome: 'awaiting_approval', approvalRequestId: 'apr-1' }),
  createdAt: new Date('2026-09-06T10:00:01Z'),
});

const replayedRow = (): FeedToolCallRow => ({
  toolCallId: CALL_ID,
  toolName: 'ask_user',
  card: 'question',
  presented: {
    card: 'question',
    prompt: QUESTION,
    options: OPTIONS,
    answer: OPTIONS[1],
  },
  durationMs: 6,
  turn: 1,
  toolInput: { question: QUESTION, options: OPTIONS },
  toolOutput: JSON.stringify({ answer: OPTIONS[1], option_index: 1 }),
  createdAt: new Date('2026-09-06T10:05:00Z'),
});

const pendingQuestion = (): FeedQuestionRow => ({
  approvalRequestId: 'apr-1',
  toolCallId: CALL_ID,
  status: 'pending',
  answer: null,
  notes: null,
});

/** Les étapes `tool` du premier tour, cartes et repliées confondues. */
function toolSteps(blocks: readonly TurnBlock[]): Array<Extract<Step, { kind: 'tool' }>> {
  const out: Array<Extract<Step, { kind: 'tool' }>> = [];
  for (const b of blocks) {
    if (b.kind === 'card') out.push(b.step);
    if (b.kind === 'steps') {
      for (const s of b.steps) if (s.kind === 'tool') out.push(s);
    }
  }
  return out;
}

function firstTurnBlocks(feed: ReturnType<typeof buildConversationFeed>): TurnBlock[] {
  const turn = feed.items.find((i) => i.kind === 'turn');
  if (turn?.kind !== 'turn') throw new Error('no turn in the feed');
  return turn.blocks;
}

describe('une question en attente', () => {
  it("se montre SEULE, avec l'état de sa ligne, alors que l'appel n'a pas réussi", () => {
    const feed = buildConversationFeed(job(), [suspendedRow()], [], [pendingQuestion()]);
    const blocks = firstTurnBlocks(feed);

    const cards = blocks.filter((b) => b.kind === 'card');
    expect(cards).toHaveLength(1);
    const step = cards[0]!.kind === 'card' ? cards[0]!.step : null;
    expect(step?.card).toBe('question');
    expect(step?.outcome).toBe('awaiting_approval');
    expect(step?.question).toEqual({
      approvalRequestId: 'apr-1',
      status: 'pending',
      answer: null,
      notes: null,
    });
  });

  it("sans ligne d'approbation chargée, elle reste une étape repliée — pas de boutons orphelins", () => {
    const feed = buildConversationFeed(job(), [suspendedRow()], [], []);
    const blocks = firstTurnBlocks(feed);

    expect(blocks.filter((b) => b.kind === 'card')).toHaveLength(0);
    const steps = toolSteps(blocks);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.question).toBeNull();
  });

  it("la règle porte sur la CARTE et l'état, jamais sur le nom de l'outil", () => {
    const base: Extract<Step, { kind: 'tool' }> = {
      kind: 'tool',
      toolName: 'un_autre_outil_qui_demande',
      toolCallId: CALL_ID,
      jobId: 'job-1',
      card: 'question',
      presented: null,
      input: {},
      outputText: null,
      outcome: 'awaiting_approval',
      durationMs: null,
      question: { approvalRequestId: 'apr-9', status: 'pending', answer: null, notes: null },
    };
    expect(showsAlone(base)).toBe(true);
    // Une carte de résultat ordinaire en attente reste repliée : rien n'a changé
    // pour les autres.
    expect(showsAlone({ ...base, card: 'files', question: null })).toBe(false);
  });
});

describe('une question répondue', () => {
  it('porte la réponse, et la carte la lit depuis la charge utile de la reprise', () => {
    const answered: FeedQuestionRow = {
      approvalRequestId: 'apr-1',
      toolCallId: CALL_ID,
      status: 'approved',
      answer: OPTIONS[1]!,
      notes: null,
    };
    const feed = buildConversationFeed(job(), [suspendedRow(), replayedRow()], [], [answered]);
    const blocks = firstTurnBlocks(feed);
    const cards = blocks.filter((b) => b.kind === 'card');
    expect(cards).toHaveLength(1);
    const step = cards[0]!.kind === 'card' ? cards[0]!.step : null;
    expect(step?.question?.status).toBe('approved');
    expect(step?.presented).toMatchObject({ card: 'question', answer: OPTIONS[1] });
  });

  it('déclinée : la carte se montre quand même, avec la raison', () => {
    const declined: FeedQuestionRow = {
      approvalRequestId: 'apr-1',
      toolCallId: CALL_ID,
      status: 'rejected',
      answer: null,
      notes: 'None of these fits',
    };
    const feed = buildConversationFeed(job(), [suspendedRow()], [], [declined]);
    const blocks = firstTurnBlocks(feed);
    const cards = blocks.filter((b) => b.kind === 'card');
    expect(cards).toHaveLength(1);
    const step = cards[0]!.kind === 'card' ? cards[0]!.step : null;
    expect(step?.question?.notes).toBe('None of these fits');
  });
});

describe('deux lignes d’audit pour un même appel', () => {
  it("n'en font qu'UNE étape, celle de la dernière — pour toutes les cartes, pas seulement les questions", () => {
    const answered: FeedQuestionRow = {
      approvalRequestId: 'apr-1',
      toolCallId: CALL_ID,
      status: 'approved',
      answer: OPTIONS[1]!,
      notes: null,
    };
    const feed = buildConversationFeed(job(), [suspendedRow(), replayedRow()], [], [answered]);
    const steps = toolSteps(firstTurnBlocks(feed));
    expect(steps).toHaveLength(1);
    // La DERNIÈRE ligne l'emporte : celle de la reprise, avec son issue et sa
    // durée. Sans cette règle, le fil montrerait le travail comme encore en
    // attente alors qu'il a repris.
    expect(steps[0]!.outcome).toBe('success');
    expect(steps[0]!.durationMs).toBe(6);
    expect(feed.totals.toolCalls).toBe(1);
  });
});
