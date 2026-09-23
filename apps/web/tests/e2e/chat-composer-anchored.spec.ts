/**
 * chat-composer-anchored.spec.ts — la saisie reste en bas pendant qu'une réponse s'écrit.
 *
 * Constaté par Quentin le 23/09, sur une conversation NEUVE : pendant
 * qu'Alfred écrivait une longue note, la saisie descendait sous le bord de
 * l'écran au fil du texte, et le bouton Stop (#456) devenait presque
 * impossible à atteindre. La cause : sur l'écran de conversation neuve, la
 * saisie vivait DANS la colonne qui défile, sous la réponse.
 *
 * Ce que ce parcours prouve, au navigateur, sur les DEUX écrans où l'on écrit
 * (le fil existant, et la conversation neuve de `/`) : pendant qu'une réponse
 * longue s'écrit, la saisie tient entière dans la fenêtre et Stop est cliquable.
 *
 * Aucun modèle n'est appelé : `fetch('/api/chat/stream')` est remplacé dans la
 * page par un flux qui livre un long texte et NE SE TERMINE PAS — l'état exact
 * d'une réponse en train de s'écrire. `route.fulfill` ne sait pas tenir un flux
 * ouvert, d'où le remplacement côté page.
 *
 * Conventions : requireLiveStack() en beforeAll, storageState via la config.
 */

import { test, expect, type Page } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

/** Un flux de réponse qui écrit 120 paragraphes et reste ouvert. */
async function fakeEndlessAnswer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/api/chat/stream')) return real(input, init);
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 1; i <= 120; i++) {
            const text = `Paragraphe ${i} : une phrase assez longue pour remplir une ligne du fil.\n\n`;
            controller.enqueue(enc.encode(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`));
          }
          // Jamais fermé : la réponse « s'écrit » encore.
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  await page.route('**/api/chat/stop', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"stopped":true}' }),
  );
}

/** La saisie tient entière dans la fenêtre, et Stop est là, cliquable. */
async function expectComposerAnchored(page: Page): Promise<void> {
  await expect(page.getByText('Paragraphe 120 :')).toBeAttached();
  const viewport = page.viewportSize()!;
  const box = await page
    .getByTestId('composer-stop')
    .locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
    .boundingBox();
  expect(box, 'the composer is rendered').not.toBeNull();
  expect(box!.y + box!.height, 'composer bottom inside the window').toBeLessThanOrEqual(
    viewport.height,
  );
  // Et le texte MONTE : le dernier paragraphe écrit est visible, au-dessus de
  // la saisie — pas en train de s'allonger dessous (Quentin, 23/09).
  const last = page.getByText('Paragraphe 120 :');
  await expect(last).toBeInViewport();
  const lastBox = await last.boundingBox();
  expect(lastBox, 'the last paragraph is rendered').not.toBeNull();
  expect(lastBox!.y + lastBox!.height, 'last paragraph above the composer').toBeLessThanOrEqual(
    box!.y,
  );
  const stop = page.getByTestId('composer-stop');
  await expect(stop).toBeInViewport();
  await stop.click();
}

test.describe('Saisie ancrée pendant une réponse @cap:parler-a-un-agent/ecran', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('sur un fil existant', async ({ page }) => {
    await fakeEndlessAnswer(page);
    await page.goto('/chat');
    const threads = page.locator('a[href^="/chat/"]');
    test.skip((await threads.count()) === 0, 'no conversation to write in');
    await threads.first().click();
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}/);

    await page.getByPlaceholder(/Reply/).fill('Écris une très longue note');
    await page.getByTestId('composer-send').click();

    await expectComposerAnchored(page);
  });

  test('sur une conversation neuve (l’écran où Quentin l’a vu)', async ({ page }) => {
    await fakeEndlessAnswer(page);
    await page.goto('/');
    const box = page.locator('textarea').first();
    await box.fill('Écris une très longue note');
    await page.getByTestId('composer-send').click();

    await expectComposerAnchored(page);
  });
});
