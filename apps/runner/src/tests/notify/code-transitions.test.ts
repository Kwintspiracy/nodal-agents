// code-transitions.test.ts — le kanban minimal du pipeline code (punch list
// V1.1) : ✔/✖ quand un code_task se termine, 🔎 quand un verdict tombe.
//
// Deux contrats à figer, dans cet ordre :
//   1. le CONDENSÉ — une ligne d'état, jamais une sortie d'outil ; le texte
//      envoyé est asserté en entier, pas par présence d'un fragment ;
//   2. la GARDE anti-spam — seul un job racine né sur un canal de MESSAGERIE
//      déclenche l'envoi ; un job dashboard (l'utilisateur regarde l'onglet
//      Code en live) ne produit AUCUN appel réseau.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agents, agentJobs, telegramAllowedChats } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import { notifyCodeTransition, renderCodeTransition } from '../../notify/code-transitions.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

const CHAT_ID = '199791464';

const fetchMock = vi.fn(
  async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);
vi.stubGlobal('fetch', fetchMock);

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  // Le propriétaire du bot — la cible de livraison passe par CETTE ligne
  // (resolveApprovalDeliveryTarget), jamais par agent_jobs.chat_id seul.
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId: CHAT_ID,
    role: 'owner',
    status: 'active',
  });
  await db.update(agents).set({ telegramBotToken: '123:fake' }).where(eq(agents.id, seed.agentId));
});

beforeEach(async () => {
  fetchMock.mockClear();
  await db
    .update(agentJobs)
    .set({ channel: 'telegram', chatId: CHAT_ID })
    .where(eq(agentJobs.id, seed.jobId));
});

function sentText(): string {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain('/sendMessage');
  return (JSON.parse(init.body as string) as { text: string }).text;
}

describe('notifyCodeTransition', () => {
  it('code_task réussi → « ✔ Code task finished — <agent> », le texte ENTIER, rien d’autre', async () => {
    const [agentRow] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, seed.agentId));

    await notifyCodeTransition(db as RunnerDeps['db'], seed.jobId, {
      kind: 'code_task_done',
      success: true,
      agentName: agentRow!.name,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Le texte est asserté EN ENTIER : la moindre sortie d'outil qui s'y
    // glisserait un jour ferait échouer ce test, c'est son rôle.
    expect(sentText()).toBe(`✔ Code task finished — ${agentRow!.name}`);
  });

  it('code_task échoué → ✖, verdict de review → 🔎 avec le label lisible', async () => {
    await notifyCodeTransition(db as RunnerDeps['db'], seed.jobId, {
      kind: 'code_task_done',
      success: false,
      agentName: 'Dev C',
    });
    expect(sentText()).toBe('✖ Code task failed — Dev C');

    fetchMock.mockClear();
    await notifyCodeTransition(db as RunnerDeps['db'], seed.jobId, {
      kind: 'review_verdict',
      verdict: 'approve',
      agentName: 'Reviewer',
    });
    expect(sentText()).toBe('🔎 Review: approved — Reviewer');
  });

  it('job racine né sur le DASHBOARD → aucun envoi (l’onglet Code est déjà sous ses yeux)', async () => {
    await db.update(agentJobs).set({ channel: 'dashboard' }).where(eq(agentJobs.id, seed.jobId));

    await notifyCodeTransition(db as RunnerDeps['db'], seed.jobId, {
      kind: 'code_task_done',
      success: true,
      agentName: 'Dev C',
    });

    expect(fetchMock, 'un job dashboard a été notifié par message').not.toHaveBeenCalled();
  });

  it('job racine cron → silencieux aussi (deliverCompletedRoots couvre déjà la fin)', async () => {
    await db.update(agentJobs).set({ channel: 'cron' }).where(eq(agentJobs.id, seed.jobId));

    await notifyCodeTransition(db as RunnerDeps['db'], seed.jobId, {
      kind: 'code_task_done',
      success: true,
      agentName: 'Dev C',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('renderCodeTransition', () => {
  it('request_changes est traduit, un verdict inconnu passe tel quel, agent absent = pas de tiret', () => {
    expect(
      renderCodeTransition({ kind: 'review_verdict', verdict: 'request_changes', agentName: null }),
    ).toBe('🔎 Review: changes requested');
    expect(
      renderCodeTransition({ kind: 'review_verdict', verdict: 'escalate', agentName: null }),
    ).toBe('🔎 Review: escalate');
    expect(renderCodeTransition({ kind: 'code_task_done', success: true, agentName: null })).toBe(
      '✔ Code task finished',
    );
  });
});
