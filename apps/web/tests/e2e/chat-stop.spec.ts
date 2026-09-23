/**
 * chat-stop.spec.ts — Envoyer devient Stop pendant qu'une réponse s'écrit (#456).
 *
 * Ce que ce parcours prouve, au navigateur :
 *   — pendant qu'une réponse est attendue, le bouton de la saisie est Stop ;
 *   — un clic sur Stop demande l'arrêt de CETTE conversation (`/api/chat/stop`) ;
 *   — la réponse (arrêtée) revenue, le bouton redevient Envoyer ;
 *   — dès qu'on tape pendant l'attente, c'est Envoyer qui revient (la file
 *     accepte un message de plus, Quentin 18/09).
 *
 * Aucun modèle n'est appelé : le flux `/api/chat/stream` est intercepté et
 * RETENU jusqu'au clic sur Stop, puis rendu avec un `done` arrêté — la forme
 * exacte que le runner rend (`stopped: true`). Ce que le runner fait du Stop
 * est prouvé côté moteur (`apps/runner/src/tests/chat/chat-stop.test.ts`).
 *
 * Conventions : requireLiveStack() en beforeAll, storageState via la config.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('Stop dans le chat @cap:parler-a-un-agent/ecran', () => {
  test('Envoyer devient Stop pendant la réponse, et Stop arrête CETTE conversation', async ({
    page,
  }) => {
    await page.goto('/chat');
    const threads = page.locator('a[href^="/chat/"]');
    // Base vide (une CI fraîche) : aucun fil où écrire, rien à prouver ici.
    test.skip((await threads.count()) === 0, 'no conversation to write in');
    await threads.first().click();
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}/);
    const conversationId = page.url().match(/\/chat\/([0-9a-f-]{36})/)![1]!;

    let releaseStream: () => void = () => {};
    const stopAsked = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const stopBodies: unknown[] = [];

    await page.route('**/api/chat/stop', async (route) => {
      stopBodies.push(route.request().postDataJSON());
      releaseStream();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"stopped":true}',
      });
    });
    await page.route('**/api/chat/stream', async (route) => {
      // La réponse n'arrive qu'après le Stop : tant qu'il n'est pas cliqué, le
      // tour « écrit » encore.
      await stopAsked;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          'event: done\ndata: ' +
          JSON.stringify({
            reply: 'Le début de la note\n\n[stopped by the user]',
            spawnedJobId: null,
            streamed: true,
            stopped: true,
          }) +
          '\n\n',
      });
    });

    const box = page.getByPlaceholder(/Reply/);
    await box.fill('Écris une très longue note');
    await page.getByTestId('composer-send').click();

    // Pendant l'attente : Stop, à la place d'Envoyer.
    const stop = page.getByTestId('composer-stop');
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAccessibleName('Stop the answer');
    await expect(page.getByTestId('composer-send')).toHaveCount(0);

    // Taper pendant l'attente rend Envoyer ; vider la zone rend Stop.
    await box.fill('un autre message');
    await expect(page.getByTestId('composer-send')).toBeVisible();
    await box.fill('');
    await expect(stop).toBeVisible();

    await stop.click();

    // La réponse arrêtée revenue : Envoyer revient, Stop s'en va.
    await expect(page.getByTestId('composer-send')).toBeVisible();
    await expect(page.getByTestId('composer-stop')).toHaveCount(0);
    // Et le Stop visait CETTE conversation, une seule fois.
    expect(stopBodies).toEqual([{ conversationId }]);
  });
});
