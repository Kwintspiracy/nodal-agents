/**
 * thread-autoscroll.spec.ts
 *
 * Un fil s'ouvre EN BAS, sur son dernier message.
 *
 * Avant la PR « le fil dit la vérité », rien ne faisait défiler un fil :
 * `scrollIntoView` / `scrollTop` n'existaient dans aucun écran de conversation.
 * Un message qui arrivait se posait sous le bord bas de la zone visible, contre
 * la saisie, et il fallait faire défiler à la main pour le lire (Quentin,
 * 08/09/2026).
 *
 * Ce que cette spec prouve, au navigateur, ce que le test unitaire de
 * `staysAtBottom` ne peut pas prouver :
 *   A — à l'ouverture d'un fil assez long pour défiler, on est en bas ;
 *   B — après avoir remonté, on N'EST PLUS ramené en bas tout seul.
 *
 * Conventions : requireLiveStack() en beforeAll, storageState via la config.
 */

import { test, expect, type Page } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

/** La zone qui défile dans un fil — marquée, car le layout du dashboard
 * porte lui aussi `overflow-y-auto` et serait trouvé en premier. */
async function scrollMetrics(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
    if (!el) return null;
    return {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
    };
  });
}

/**
 * Ouvre le fil de /chat qui a le plus de contenu sous la ligne de flottaison.
 *
 * Rend la marge de défilement du fil retenu. ÉCHOUE — plutôt que de sauter —
 * si aucun fil ne porte de zone de défilement : un test sauté en silence ne
 * dirait pas la différence entre « pas de fil assez long » et « le composant
 * n'est pas monté », et c'est justement la seconde qu'il doit attraper.
 */
async function openScrollableThread(page: Page): Promise<number> {
  await page.goto('/chat');
  const links = page.locator('a[href^="/chat/"]');
  const count = Math.min(await links.count(), 8);
  // Base vide (une CI fraîche, par exemple) : rien à prouver ici, on saute.
  // C'est le SEUL saut légitime — voir plus bas pour celui qui n'en est pas un.
  if (count === 0) return 0;

  let best = 0;
  let scrollerSeen = false;
  for (let i = 0; i < count; i++) {
    await page.goto('/chat');
    await links.nth(i).click();
    await page.waitForLoadState('networkidle');
    const m = await scrollMetrics(page);
    if (m) {
      scrollerSeen = true;
      const slack = m.scrollHeight - m.clientHeight;
      // « Assez long pour défiler » : de quoi remonter franchement.
      if (slack > 200) return slack;
      best = Math.max(best, slack);
    }
  }
  // Des fils existent, mais aucun ne porte la zone de défilement : le composant
  // n'est pas monté. C'est un ÉCHEC, jamais un saut — un test sauté en silence
  // ne dirait pas la différence entre « rien à mesurer » et « rien ne marche ».
  expect(scrollerSeen, 'des fils existent mais aucun ne porte [data-thread-scroller]').toBe(true);
  return best;
}

test('A — un fil long s’ouvre sur son dernier message @cap:suivre-execution/ecran', async ({
  page,
}) => {
  test.skip((await openScrollableThread(page)) <= 200, 'aucun fil assez long dans cette base');

  const m = await scrollMetrics(page);
  expect(m).not.toBeNull();
  // En bas, à la marge près (celle de staysAtBottom).
  expect(m!.scrollHeight - m!.scrollTop - m!.clientHeight).toBeLessThan(64);
});

test('C — remonter APRÈS un fil déjà en bas : le geste du lecteur n’est pas avalé', async ({
  page,
}) => {
  // Revue Codex PR #48, constat 5. Ouvrir un fil déjà en bas ne produit aucun
  // événement de défilement : le drapeau « c'est nous qui défilons » restait
  // armé et avalait le PREMIER vrai geste du lecteur, qui se faisait alors
  // ramener en bas à la première croissance du contenu.
  test.skip((await openScrollableThread(page)) <= 200, 'aucun fil assez long dans cette base');

  // Le fil s'ouvre en bas. Un premier geste, tout de suite : il doit compter.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
    if (el) el.scrollTop = 0;
  });
  // Forcer le contenu à grandir : c'est ce qui ramenait le lecteur en bas.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
    const inner = el?.firstElementChild as HTMLElement | null;
    if (inner) inner.appendChild(document.createElement('div')).style.height = '900px';
  });
  await page.waitForTimeout(600);

  const m = await scrollMetrics(page);
  expect(m).not.toBeNull();
  expect(m!.scrollTop, 'le lecteur a été ramené en bas malgré son geste').toBeLessThan(64);
});

test('D — remonter PENDANT qu’un défilement automatique est en vol', async ({ page }) => {
  // Revue Codex PR #48, passe 3. Le navigateur FUSIONNE les événements de
  // défilement d'un même élément (CSSOM View §13.2) : compter ceux qu'on a
  // provoqués ne peut pas marcher, puisqu'on ne sait pas combien arriveront.
  //
  // L'entrelacement : le contenu grandit, le composant descend, et le lecteur
  // remonte AVANT que l'événement ne soit distribué. L'unique événement reçu
  // porte alors la position du LECTEUR, et se faisait prendre pour le nôtre.
  test.skip((await openScrollableThread(page)) <= 200, 'aucun fil assez long dans cette base');

  await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
    const inner = el?.firstElementChild as HTMLElement | null;
    if (!el || !inner) return;
    // Le contenu grandit : le composant va descendre tout seul.
    inner.appendChild(document.createElement('div')).style.height = '900px';
    // Laisser l'observateur agir…
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    // …puis remonter TOUT DE SUITE, dans le même tour de boucle.
    el.scrollTop = 0;
  });

  // Et une nouvelle croissance : c'est elle qui ramenait le lecteur en bas.
  await page.evaluate(() => {
    const inner = document.querySelector<HTMLElement>('[data-thread-scroller]')
      ?.firstElementChild as HTMLElement | null;
    if (inner) inner.appendChild(document.createElement('div')).style.height = '900px';
  });
  await page.waitForTimeout(600);

  const m = await scrollMetrics(page);
  expect(m).not.toBeNull();
  expect(m!.scrollTop, 'le lecteur a été ramené en bas malgré sa remontée').toBeLessThan(64);
});

test('B — remonter dans l’historique tient : on n’est pas ramené en bas @cap:reprendre-conversation/ecran', async ({
  page,
}) => {
  test.skip((await openScrollableThread(page)) <= 200, 'aucun fil assez long dans cette base');

  // Remonter franchement, puis laisser le fil vivre (LiveRefresh recharge).
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
    if (el) el.scrollTop = 0;
  });
  await page.waitForTimeout(3000);

  const m = await scrollMetrics(page);
  expect(m).not.toBeNull();
  // Toujours en haut : le rafraîchissement ne doit pas voler la position.
  expect(m!.scrollTop).toBeLessThan(64);
});
