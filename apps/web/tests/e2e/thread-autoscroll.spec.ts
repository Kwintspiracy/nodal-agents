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
 * Le fil est SEMÉ par la spec (issue #997). Elle ouvrait « le fil le plus long
 * de /chat » et sautait quand il n'y en avait pas d'assez long : sur la base
 * d'une mesure nocturne (une installation neuve) il n'y en a jamais, donc les
 * quatre parcours étaient « sautés » nuit après nuit — au vert de personne, et
 * pour rien dire. Un parcours dont la donnée est le sujet la fabrique.
 *
 * Elle n'attend pas non plus `networkidle` : la page d'un fil garde ouvert un
 * flux de poussée du runner (`ConversationEvents`, `GET /api/events`, #944), qui
 * est une requête en vol PAR CONCEPTION. Le réseau n'y est jamais « au repos »,
 * et c'est ce qui a rendu les quatre parcours rouges dès que le flux est arrivé
 * (3 novembre). Ce qu'on attend est nommé : le fil est branché
 * (`data-scroller-ready`) et sa géométrie est posée.
 *
 * Aucun modèle n'est appelé. Les lignes sont semées en base, comme dans
 * `thread-unfold-keeps-scroll.spec.ts`, et supprimées en `afterAll`.
 *
 * Conventions : requireLiveStack() en beforeAll, storageState via la config.
 */

import { test, expect, type Page } from '@playwright/test';
import { makeDbClient, requireLiveStack, resolveActingUser, testSlugSuffix } from './helpers.ts';

/** Marge de défilement sous laquelle un fil compte comme « assez long » : de quoi remonter franchement. */
const ENOUGH_SLACK_PX = 200;

let conversationId: string;
const created: { conversationIds: string[]; agentIds: string[]; jobIds: string[] } = {
  conversationIds: [],
  agentIds: [],
  jobIds: [],
};

test.beforeAll(async () => {
  await requireLiveStack();
  conversationId = await seedLongThread();
});

test.afterAll(async () => {
  const { agentJobs, chatMessages, conversations, agents, inArray } =
    await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    if (created.conversationIds.length > 0) {
      await db
        .delete(chatMessages)
        .where(inArray(chatMessages.conversationId, created.conversationIds));
      if (created.jobIds.length > 0) {
        await db.delete(agentJobs).where(inArray(agentJobs.id, created.jobIds));
      }
      await db.delete(conversations).where(inArray(conversations.id, created.conversationIds));
    }
    if (created.agentIds.length > 0) {
      await db.delete(agents).where(inArray(agents.id, created.agentIds));
    }
  } finally {
    await close();
  }
});

/**
 * Sème UNE conversation du dashboard, de la prose seulement, assez haute pour
 * défiler très au-delà de n'importe quelle fenêtre de test, et terminée par un
 * travail qui court (pour que la page se relise). Aucun appel d'outil : ce
 * fichier prouve le suivi du bas, pas le contenu du fil.
 */
async function seedLongThread(): Promise<string> {
  const { agentJobs, agents, chatMessages, conversations } = await import('@nodal-agents/db');
  const acting = await resolveActingUser();
  const { db, close } = makeDbClient();
  const suffix = testSlugSuffix();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: `E2E Autoscroll ${suffix}`,
        slug: `e2e-autoscroll-${suffix}`,
        // NOT NULL sans défaut, et jamais lu ici : aucun modèle ne tourne.
        personality: 'E2E fixture — never executed.',
        role: 'agent',
        active: true,
      })
      .returning({ id: agents.id });
    created.agentIds.push(agent!.id);

    const [conversation] = await db
      .insert(conversations)
      .values({
        entityId: acting.entityId,
        agentId: agent!.id,
        title: `Autoscroll ${suffix}`,
        origin: 'user',
        channel: 'dashboard',
      })
      .returning({ id: conversations.id });
    created.conversationIds.push(conversation!.id);

    const t0 = Date.now() - 3_600_000;
    const rows: (typeof chatMessages.$inferInsert)[] = [];
    for (let i = 0; i < 12; i++) {
      rows.push({
        entityId: acting.entityId,
        agentId: agent!.id,
        conversationId: conversation!.id,
        role: 'user' as const,
        content: `Question number ${i + 1}.`,
        createdAt: new Date(t0 + i * 2_000),
      });
      rows.push({
        entityId: acting.entityId,
        agentId: agent!.id,
        conversationId: conversation!.id,
        role: 'assistant' as const,
        content: Array.from(
          { length: 6 },
          (_, line) =>
            `Answer ${i + 1}, line ${line + 1}: filler prose that gives the thread height.`,
        ).join('\n\n'),
        createdAt: new Date(t0 + i * 2_000 + 1_000),
      });
    }
    // Un dernier travail qui COURT : tant qu'un travail court, la page se
    // relit toute seule (`LiveRefresh live`, toutes les 3 s), et c'est ce
    // rafraîchissement que le cas B doit voir passer sans perdre le lecteur.
    // Aucun runner ne le reprend ici : il reste `processing` pour toute la spec.
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: acting.entityId,
        agentId: agent!.id,
        conversationId: conversation!.id,
        channel: 'dashboard',
        task: 'E2E autoscroll — a run that stays in flight',
        status: 'processing',
        createdAt: new Date(t0 + 30_000),
      })
      .returning({ id: agentJobs.id });
    created.jobIds.push(job!.id);
    rows.push({
      entityId: acting.entityId,
      agentId: agent!.id,
      conversationId: conversation!.id,
      role: 'assistant' as const,
      content: 'Working on it.',
      jobId: job!.id,
      createdAt: new Date(t0 + 31_000),
    });
    await db.insert(chatMessages).values(rows);
    return conversation!.id;
  } finally {
    await close();
  }
}

/** Un message de plus dans le fil semé, comme s'il venait d'arriver. */
async function seedArrival(content: string): Promise<void> {
  const { chatMessages } = await import('@nodal-agents/db');
  const acting = await resolveActingUser();
  const { db, close } = makeDbClient();
  try {
    await db.insert(chatMessages).values({
      entityId: acting.entityId,
      agentId: created.agentIds[0]!,
      conversationId,
      role: 'assistant',
      content,
    });
  } finally {
    await close();
  }
}

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
 * Ouvre le fil semé, attend qu'il soit branché et que sa géométrie soit posée,
 * et rend sa marge de défilement.
 *
 * ÉCHOUE — jamais ne saute — si le fil n'est pas assez long ou si la zone de
 * défilement n'est pas montée : un test sauté en silence ne dirait pas la
 * différence entre « rien à mesurer » et « rien ne marche », et c'est
 * justement le second cas qu'il doit attraper.
 */
async function openScrollableThread(page: Page): Promise<number> {
  await page.goto(`/chat/${conversationId}`);
  // Les messages viennent du SERVEUR : ils sont à l'écran avant que
  // `ThreadScroller` n'existe. Le marqueur dit que le composant est monté.
  await expect(
    page.locator('[data-thread-scroller][data-scroller-ready]'),
    'le fil n’a jamais été branché : aucun [data-thread-scroller] monté',
  ).toBeAttached({ timeout: 15_000 });

  // Géométrie posée : deux relevés consécutifs identiques.
  let previous: string | null = null;
  await expect
    .poll(
      async () => {
        const m = await scrollMetrics(page);
        const now = JSON.stringify(m);
        const settled = previous === now;
        previous = now;
        return settled;
      },
      { timeout: 10_000, intervals: [50, 50, 100, 100, 200, 250] },
    )
    .toBe(true);

  const m = await scrollMetrics(page);
  expect(m, 'le fil ne porte pas [data-thread-scroller]').not.toBeNull();
  const slack = m!.scrollHeight - m!.clientHeight;
  expect(
    slack,
    'le fil semé devrait défiler : sinon aucun parcours ne prouve rien',
  ).toBeGreaterThan(ENOUGH_SLACK_PX);
  return slack;
}

test('A — un fil long s’ouvre sur son dernier message @cap:suivre-execution/ecran', async ({
  page,
}) => {
  await openScrollableThread(page);

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
  await openScrollableThread(page);

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
  await openScrollableThread(page);

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
  await openScrollableThread(page);

  // Remonter franchement…
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
    if (el) el.scrollTop = 0;
  });

  // …puis laisser le fil vivre POUR DE VRAI : un message arrive en base, et la
  // page le relit toute seule (`LiveRefresh`, le travail du fil court). On
  // attend que le message soit dans le DOM — la preuve que le rafraîchissement
  // a eu lieu et que le fil a grandi — avant de regarder où est le lecteur.
  // Une attente fixe ne prouvait pas qu'un rafraîchissement avait eu lieu.
  const arrival = `Late arrival ${testSlugSuffix()}`;
  await seedArrival(arrival);
  await expect(
    page.getByText(arrival),
    'la page ne s’est pas relue : le message arrivé en base n’est jamais apparu',
  ).toBeAttached({ timeout: 15_000 });

  const m = await scrollMetrics(page);
  expect(m).not.toBeNull();
  // Toujours en haut : le rafraîchissement ne doit pas voler la position.
  expect(m!.scrollTop, 'le lecteur a été ramené en bas par le rafraîchissement').toBeLessThan(64);
});
