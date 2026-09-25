/**
 * chat-live-reattach.spec.ts — revenir sur une conversation PENDANT la réponse (#457).
 *
 * Le 23/09 : la personne ouvre une autre page pendant qu'Alfred écrit, revient,
 * et ne voit que sa question — rien ne dit que la réponse s'écrit ; elle tombe
 * d'un coup des minutes plus tard. Ce parcours prouve, au navigateur :
 *   — une conversation dont la dernière question attend sa réponse, rouverte
 *     après être allé ailleurs, demande le tour en cours (`/api/chat/live`) ;
 *   — ce qui avait déjà été écrit s'affiche sous la question, avec l'agent ;
 *   — la saisie offre Stop, qui arrête CE tour.
 *
 * Aucun modèle n'est appelé : la question est posée en base (un tour dont la
 * réponse n'est pas encore écrite), et `/api/chat/live` est intercepté avec la
 * forme exacte que la route rend. Que le texte GRANDISSE fragment après
 * fragment est prouvé dans `LiveTurn.test.tsx` (un flux qu'on écrit à la
 * main) ; que le runner le tienne et le diffuse, dans
 * `apps/runner/src/tests/chat/chat-live.test.ts`.
 *
 * Conventions : requireLiveStack() en beforeAll, storageState via la config.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, makeDbClient, resolveActingUser, testSlugSuffix } from './helpers.ts';

const suffix = testSlugSuffix();
const QUESTION = `Explique la machine à vapeur ${suffix}`;
let agentId = '';
let conversationId = '';

test.beforeAll(async () => {
  await requireLiveStack();
  const acting = await resolveActingUser();
  const { agents, conversations, chatMessages } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: `Alfred ${suffix}`,
        slug: `e2e-live-${suffix}`,
        personality: 'E2E fixture, never executed.',
        active: true,
      })
      .returning({ id: agents.id });
    agentId = agent!.id;
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: acting.entityId, agentId, title: `Live ${suffix}` })
      .returning({ id: conversations.id });
    conversationId = conv!.id;
    // La question est en base, sa réponse pas encore : le tour s'écrit.
    await db.insert(chatMessages).values({
      entityId: acting.entityId,
      agentId,
      conversationId,
      role: 'user',
      content: QUESTION,
    });
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  const { agents, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // La conversation et ses messages partent avec l'agent (cascade).
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  } finally {
    await close();
  }
});

test.describe('revenir pendant la réponse @cap:parler-a-un-agent/ecran', () => {
  test('la page rouverte montre ce qui est déjà écrit, et Stop arrête ce tour', async ({
    page,
  }) => {
    const liveBodies: unknown[] = [];
    const stopBodies: unknown[] = [];
    await page.route('**/api/chat/live', async (route) => {
      liveBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          `event: start\ndata: ${JSON.stringify({ startedAt: Date.now() - 90_000 })}\n\n` +
          `event: delta\ndata: ${JSON.stringify({ text: 'La vapeur pousse ' })}\n\n` +
          `event: delta\ndata: ${JSON.stringify({ text: 'le piston.' })}\n\n` +
          // Une réponse interceptée arrive d'un bloc : sans `end`, la page
          // lirait une lecture CASSÉE et retirerait le texte (voulu, inv. #4).
          // Avec `end`, elle relit le fil ; la réponse n'étant pas en base, le
          // fil attend toujours, et le texte suivi reste affiché.
          'event: end\ndata: {}\n\n',
      });
    });
    await page.route('**/api/chat/stop', async (route) => {
      stopBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"stopped":true}',
      });
    });

    // La personne était sur le fil, est partie ailleurs, et revient.
    await page.goto(`/chat/${conversationId}`);
    await page.goto('/agents');
    await page.goto(`/chat/${conversationId}`);

    await expect(page.getByText(QUESTION)).toBeVisible();
    await expect(page.getByTestId('pending-reply')).toContainText('La vapeur pousse le piston.');
    expect(liveBodies.at(-1)).toEqual({ conversationId });

    const stop = page.getByTestId('composer-stop');
    await expect(stop).toBeVisible();
    await stop.click();
    await expect.poll(() => stopBodies).toEqual([{ conversationId }]);
  });
});
