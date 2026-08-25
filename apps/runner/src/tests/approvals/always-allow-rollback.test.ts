// always-allow-rollback.test.ts — le bouton « 🔁 Toujours autoriser » ne doit
// jamais laisser derrière lui un droit permanent que personne n'a validé.
//
// Le geste fait DEUX écritures : poser une règle auto_approve, puis résoudre la
// demande en cours. La règle est commitée en premier, donc toute sortie qui
// n'aboutit pas doit la retirer — y compris une sortie par EXCEPTION.
//
// C'est ce dernier cas qui manquait, et il est vicieux. Sans rattrapage, un
// blip de base au milieu de la résolution laissait la règle posée et faisait
// remonter l'erreur jusqu'au poller Telegram, qui rejoue le même clic sans
// avancer son offset. La seconde tentative relisait alors l'état laissé par la
// première : l'« état d'avant » capturé valait `auto_approve`, et un échec
// propre au rejeu « restaurait » ce blanc-seing au lieu de le supprimer.
// L'utilisateur lisait « rien n'a bougé » pendant que son agent gagnait le
// droit permanent de lancer des commandes.
//
// Assertions sur les lignes réelles de approval_rules.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq, approvalRequests, approvalRules, agentJobs, agents } from '@nodal-agents/db';
import { telegramAllowedChats } from '@nodal-agents/db';
import type { TelegramUpdate } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

const CHAT_ID = '199791464';
const TOOL = 'run_command';

// La résolution est remplacée par un double qui JETTE — la panne d'infra du
// scénario. Tout le reste (écriture de la règle, capture, restauration) est le
// code réel, sur la vraie base.
vi.mock('../../approvals/resolve.ts', () => ({
  resolveApprovalDecision: async () => {
    throw new Error('connexion à la base perdue au milieu de la résolution');
  },
}));

vi.stubGlobal(
  'fetch',
  vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
);

const env = {
  WORKER_SECRET: 'test-secret',
  APP_URL: 'http://localhost:3099',
} as unknown as RunnerEnv;

let db: TestDb;
let deps: RunnerDeps;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  await db
    .update(agentJobs)
    .set({ status: 'awaiting_approval', chatId: CHAT_ID })
    .where(eq(agentJobs.id, seed.jobId));
  await db.update(agents).set({ telegramBotToken: '123:fake' }).where(eq(agents.id, seed.agentId));
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId: CHAT_ID,
    role: 'owner',
    status: 'active',
  });
  deps = { db: db as RunnerDeps['db'] } as RunnerDeps;
});

function callbackUpdate(data: string): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'cbq-rollback',
      data,
      from: { id: 42, first_name: 'Q' },
      message: { message_id: 555, chat: { id: Number(CHAT_ID), type: 'private' } },
    },
  };
}

async function reglesPosees() {
  return db
    .select({ action: approvalRules.action })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.entityId, seed.entityId),
        eq(approvalRules.agentId, seed.agentId),
        eq(approvalRules.toolName, TOOL),
      ),
    );
}

describe('« Toujours autoriser » — la résolution JETTE', () => {
  it('la règle posée est retirée AVANT que l’erreur ne remonte au poller', async () => {
    const { handleApprovalCallback } = await import('../../telegram/approval-callback.ts');

    expect(await reglesPosees(), 'le test suppose aucune règle au départ').toHaveLength(0);

    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: TOOL,
        toolInput: { command: 'echo bonjour' },
        status: 'pending',
      })
      .returning();

    // `wc` = la CONFIRMATION du « Toujours autoriser » — l'étape qui écrit la
    // règle puis résout. Le premier tap (`w`) ne fait qu'afficher la question.
    const data = `apr:${approval!.id}:wc`;

    // L'erreur DOIT remonter : c'est elle qui fait rejouer le clic par le
    // poller. Ce qu'on interdit, c'est qu'elle remonte en laissant la règle.
    await expect(
      handleApprovalCallback({
        update: callbackUpdate(data),
        botToken: '123:fake',
        receivingAgentId: seed.agentId,
        deps,
        env,
      }),
    ).rejects.toThrow(/connexion à la base perdue/);

    expect(
      await reglesPosees(),
      'un droit permanent a survécu à une résolution qui a échoué',
    ).toHaveLength(0);
  });
});
