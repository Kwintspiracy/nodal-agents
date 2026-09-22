// result-from-current-turn.test.ts — issue #419.
//
// Le job Telegram « T'es la ? » du 22/09 (8a619c96) a répondu par
// `telegram_send_message` puis `return_result {status: 'success'}` : aucun
// texte assistant à ce tour. Son `result` en base était pourtant
// « [Delegated to Researcher (completed) — actions: skill_view, tavily_search,
// return_result] » — la ligne de grand livre d'une délégation du 15/09, que
// l'historique rejoué du fil porte en part de TEXTE dans un message assistant
// synthétique. Le « dernier texte assistant » balayé sur toute la transcription
// la prenait pour la réponse du jour ; le tour suivant la rejouait comme si
// l'agent l'avait envoyée sur Telegram.
//
// Ce que ces tests prouvent : le repli lit le TOUR COURANT, du message
// utilisateur qui porte la tâche jusqu'à la fin, et rien avant. Assertions sur
// la ligne relue en base, jamais sur un appel.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs } from '@nodal-agents/db';
import { completeJob, currentTurnMessages } from '../../job/state.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

const TASK = 'T’es la ?';
const LEDGER =
  '[Delegated to Researcher (completed) — actions: skill_view, tavily_search, return_result]';

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

async function telegramJob(): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      task: TASK,
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function resultOf(jobId: string): Promise<string | null> {
  const [r] = await db
    .select({ result: agentJobs.result })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return r?.result ?? null;
}

/** Un tour passé tel que thread-history.ts le rejoue sur un canal à outil d'envoi. */
const replayedSendBlock = (reply: string, ledgerLine: string) => [
  { role: 'user', content: 'Fais une recherche sur la longueur de Planck' },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'history-tool-0',
        toolName: 'telegram_send_message',
        input: { text: reply },
      },
      { type: 'text', text: ledgerLine },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'history-tool-0',
        toolName: 'telegram_send_message',
        output: { type: 'json', value: { sent: true } },
      },
    ],
  },
];

/** Le tour courant du 22/09 : un envoi Telegram, un accusé, aucun texte. */
const currentTurnWithoutText = [
  { role: 'user', content: TASK },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'telegram_send_message',
        input: { text: 'Oui je suis là 👋' },
      },
      {
        type: 'tool-call',
        toolCallId: 'call_2',
        toolName: 'return_result',
        input: { status: 'success' },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'telegram_send_message',
        output: { type: 'json', value: { sent: true } },
      },
      {
        type: 'tool-result',
        toolCallId: 'call_2',
        toolName: 'return_result',
        output: { type: 'json', value: { acknowledged: true } },
      },
    ],
  },
];

describe('le résultat d’un job vient de SON tour, jamais de l’historique rejoué (#419) @cap:parler-a-un-agent/moteur', () => {
  it('un tour sans texte après un bloc rejoué à ligne de grand livre laisse le résultat vide', async () => {
    const jobId = await telegramJob();
    const messages = [
      ...replayedSendBlock('Voici la longueur de Planck…', LEDGER),
      ...currentTurnWithoutText,
    ];

    await completeJob(
      db,
      jobId,
      '',
      ['telegram_send_message', 'return_result'],
      undefined,
      messages,
    );

    const result = await resultOf(jobId);
    expect(result ?? '').not.toContain('Delegated to');
    expect(result ?? '').toBe('');
  });

  it('la forme à deux messages (canal sans outil d’envoi) est écartée de la même façon', async () => {
    const jobId = await telegramJob();
    const messages = [
      { role: 'user', content: 'Test' },
      { role: 'assistant', content: `Bien reçu.\n\n${LEDGER}` },
      ...currentTurnWithoutText,
    ];

    await completeJob(
      db,
      jobId,
      '',
      ['telegram_send_message', 'return_result'],
      undefined,
      messages,
    );

    expect((await resultOf(jobId)) ?? '').toBe('');
  });

  it('un texte réellement écrit à ce tour est toujours repris, même derrière l’historique', async () => {
    const jobId = await telegramJob();
    const rapport = 'Je suis là, et voici le point.';
    const messages = [
      ...replayedSendBlock('Réponse d’avant', LEDGER),
      { role: 'user', content: TASK },
      { role: 'assistant', content: rapport },
    ];

    await completeJob(db, jobId, '', ['return_result'], undefined, messages);

    expect(await resultOf(jobId)).toBe(rapport);
  });

  it('la tranche du tour courant commence au DERNIER message qui porte la tâche, et garde les relances', () => {
    const nudge = { role: 'user', content: '[système] Le livrable manque.' };
    const messages = [
      { role: 'user', content: TASK }, // un tour passé où l'utilisateur a dit la même chose
      { role: 'assistant', content: `Oui.\n\n${LEDGER}` },
      { role: 'user', content: TASK },
      { role: 'assistant', content: 'Oui, je suis là.' },
      nudge,
      { role: 'assistant', content: 'Voici le livrable.' },
    ];

    const turn = currentTurnMessages(messages, TASK);

    expect(turn).toHaveLength(4);
    expect(turn[0]).toEqual({ role: 'user', content: TASK });
    expect(turn).toContainEqual(nudge);
    // Sans tâche retrouvée, la transcription entière — l'ancien comportement,
    // dit et non caché.
    expect(currentTurnMessages(messages, 'une tâche absente')).toHaveLength(6);
  });
});
