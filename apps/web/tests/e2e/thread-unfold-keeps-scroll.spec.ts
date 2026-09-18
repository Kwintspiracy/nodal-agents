/**
 * thread-unfold-keeps-scroll.spec.ts — déplier un bloc ne déplace pas le lecteur.
 *
 * Quentin, 18/09/2026 : « quand je déroule quoi que ce soit dans un feed, ça
 * déroule vers le haut ; si je clique sur dérouler, la position du scroll ne
 * DOIT PAS bouger et le contenu se déroule vers le bas ». Le fil suivait le bas
 * à CHAQUE croissance : un bloc ouvert depuis le bas faisait filer la zone
 * visible sous ce qu'on venait d'ouvrir.
 *
 * La PR #160 a réglé ça dans `ThreadScroller` — une croissance qui suit de près
 * un geste DANS le fil est celle du lecteur, et on ne le déplace pas. La
 * décision est une fonction pure (`growthIsTheReaders`), éprouvée par quatre cas
 * unitaires ; AUCUN ne dit ce que le navigateur fait vraiment, et c'est
 * précisément ce que l'issue #162 demande.
 *
 * Trois cas, et le premier est celui qui distingue :
 *   C — DEPUIS LE BAS, là où le suivi est allumé, un dépliage laisse `scrollTop`
 *       où il est et toute sa hauteur nouvelle part sous la zone visible. C'est
 *       le cas rapporté, et le seul que l'ancien comportement rate : neutraliser
 *       `growthIsTheReaders` fait rougir ce test, et lui seul ;
 *   A — depuis le MILIEU du fil, un dépliage ne réveille pas le suivi : la
 *       position ne bouge pas davantage ;
 *   B — revenu en bas, le lecteur est de nouveau SUIVI. Déplier éteint le suivi
 *       le temps d'un geste, il ne le tue pas.
 *
 * Aucun modèle n'est appelé ici. Les lignes sont semées directement en base,
 * comme le font les autres parcours pilotés par la base (`delegation-outcome`),
 * et tout ce qui est créé est supprimé en `afterAll`.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { makeDbClient, requireLiveStack, resolveActingUser, testSlugSuffix } from './helpers.ts';

/**
 * Marge, en pixels, sous laquelle `ThreadScroller` considère qu'on est « en
 * bas » (`AT_BOTTOM_SLACK_PX`). Recopiée plutôt qu'importée : un parcours
 * Playwright qui importerait un composant client tirerait React dans le
 * processus de test pour lire une constante. `thread-autoscroll.spec.ts` écrit
 * la même valeur, pour la même raison.
 */
const AT_BOTTOM_SLACK_PX = 64;

/**
 * Attente, en millisecondes, plus longue que la fenêtre pendant laquelle une
 * croissance passe pour le geste du lecteur (`READER_GESTURE_WINDOW_MS`, 800 ms
 * dans `ThreadScroller`). Au-delà, une croissance redevient une arrivée
 * ordinaire — c'est l'état dans lequel le cas B veut se placer.
 */
const AFTER_THE_GESTURE_MS = 1_500;

/** Le nom de l'outil semé : assez singulier pour désigner SA ligne, et une seule. */
const TOOL_NAME = 'e2e_unfold_probe';

/** Ce que l'appel a rendu : assez long pour que son dépliage se mesure. */
const TOOL_OUTPUT = Array.from(
  { length: 40 },
  (_, i) => `line ${String(i + 1).padStart(2, '0')} - recorded output of the seeded tool call`,
).join('\n');

let acting: { userId: string; entityId: string };
let conversationId: string;
const created: { jobIds: string[]; conversationIds: string[]; agentIds: string[] } = {
  jobIds: [],
  conversationIds: [],
  agentIds: [],
};

test.beforeAll(async () => {
  await requireLiveStack();
  acting = await resolveActingUser();
  conversationId = await seedThread();
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
    }
    // Les lignes `tool_calls` partent avec leur job (ON DELETE CASCADE).
    if (created.jobIds.length > 0) {
      await db.delete(agentJobs).where(inArray(agentJobs.id, created.jobIds));
    }
    if (created.conversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, created.conversationIds));
    }
    if (created.agentIds.length > 0) {
      await db.delete(agents).where(inArray(agents.id, created.agentIds));
    }
  } finally {
    await close();
  }
});

/** Une ligne de `chat_messages` telle que ce parcours l'écrit. */
type SeededMessage = {
  entityId: string;
  agentId: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  jobId?: string;
  createdAt: Date;
};

/**
 * Sème UNE conversation du dashboard qui porte, dans cet ordre :
 *   1. un premier travail — un run avec UN appel d'outil, donc un
 *      `FoldableBlock` replié — puis dix échanges ordinaires ;
 *   2. un SECOND travail, dernier item du fil.
 *
 * Les deux rangs comptent, et pour des raisons opposées. Le run du MILIEU doit
 * pouvoir être amené sous les yeux avec du fil dessous (cas A et B). Le run de
 * la FIN doit être visible à l'ouverture, quand le fil est en bas et le suivi
 * allumé — c'est là, et seulement là, que l'ancien comportement déplaçait le
 * lecteur (cas C).
 *
 * Les travaux sont `completed` : la page ne se rafraîchit donc pas toute seule
 * (`LiveRefresh live={false}`), et rien ne vient bouger le fil pendant qu'on le
 * mesure.
 */
async function seedThread(): Promise<string> {
  const { agents, agentJobs, chatMessages, conversations, toolCalls } =
    await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  const suffix = testSlugSuffix();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: `E2E Unfold ${suffix}`,
        slug: `e2e-unfold-${suffix}`,
        // NOT NULL sans défaut, et jamais lu ici : aucun modèle ne tourne dans
        // ce parcours. C'est la ligne qui compte, pas ce que l'agent dirait.
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
        title: `Unfold keeps the scroll ${suffix}`,
        origin: 'user',
        channel: 'dashboard',
      })
      .returning({ id: conversations.id });
    created.conversationIds.push(conversation!.id);

    const t0 = Date.now() - 3_600_000;
    const at = (step: number): Date => new Date(t0 + step * 1_000);

    /** Un travail avec son appel d'outil, et les deux tours de chat qui le portent. */
    const seedRun = async (rank: number, step: number): Promise<SeededMessage[]> => {
      const toolCallId = `call_${suffix}_${rank}`;
      const [head] = await db
        .insert(agentJobs)
        .values({
          entityId: acting.entityId,
          agentId: agent!.id,
          conversationId: conversation!.id,
          channel: 'dashboard',
          task: `Look up the seeded probe (${rank})`,
          status: 'completed',
          result: `Here is what probe ${rank} returned.`,
          // Le transcript porte l'appel ; la ligne d'audit ci-dessous porte son
          // résultat. Le fil a besoin des DEUX : sans le bloc `tool-call` il n'y
          // a pas d'étape, sans la ligne il n'y a pas de corps à déplier.
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: `Calling probe ${rank}.` },
                {
                  type: 'tool-call',
                  toolName: TOOL_NAME,
                  toolCallId,
                  args: { query: `the seeded probe ${rank}` },
                },
              ],
            },
          ],
          createdAt: at(step),
          completedAt: at(step + 1),
        })
        .returning({ id: agentJobs.id });
      created.jobIds.push(head!.id);

      await db.insert(toolCalls).values({
        entityId: acting.entityId,
        jobId: head!.id,
        toolName: TOOL_NAME,
        toolCallId,
        toolInput: { query: `the seeded probe ${rank}` },
        toolOutput: TOOL_OUTPUT,
        durationMs: 1_234,
        turn: 1,
        createdAt: at(step + 1),
      });

      // Le fil du dashboard marche sur `chat_messages` : un job de tête n'est
      // rendu qu'à travers la ligne assistant dont le `job_id` le désigne
      // (`conversation-thread.ts`).
      return [
        {
          entityId: acting.entityId,
          agentId: agent!.id,
          conversationId: conversation!.id,
          role: 'user',
          content: `Look up the seeded probe (${rank}).`,
          createdAt: at(step - 1),
        },
        {
          entityId: acting.entityId,
          agentId: agent!.id,
          conversationId: conversation!.id,
          role: 'assistant',
          content: 'On it.',
          jobId: head!.id,
          createdAt: at(step + 2),
        },
      ];
    };

    const rows: SeededMessage[] = [...(await seedRun(1, 1))];
    // Dix échanges de prose : ils ne servent qu'à donner du fil SOUS le premier
    // bloc à déplier.
    for (let i = 0; i < 10; i++) {
      rows.push({
        entityId: acting.entityId,
        agentId: agent!.id,
        conversationId: conversation!.id,
        role: 'user',
        content: `Follow-up question number ${i + 1}.`,
        createdAt: at(10 + i * 2),
      });
      rows.push({
        entityId: acting.entityId,
        agentId: agent!.id,
        conversationId: conversation!.id,
        role: 'assistant',
        content: Array.from(
          { length: 8 },
          (_, line) =>
            `Answer ${i + 1}, line ${line + 1}: filler prose that gives the thread height.`,
        ).join('\n\n'),
        createdAt: at(11 + i * 2),
      });
    }
    rows.push(...(await seedRun(2, 40)));

    await db.insert(chatMessages).values(rows);
    return conversation!.id;
  } finally {
    await close();
  }
}

type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/**
 * Les mesures de la zone qui défile. Marquée (`[data-thread-scroller]`) : le
 * layout du dashboard porte lui aussi `overflow-y-auto` et serait trouvé en
 * premier.
 */
async function scrollMetrics(page: Page): Promise<ScrollMetrics> {
  const m = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
    if (!el) return null;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
  expect(m, 'le fil ne porte pas [data-thread-scroller]').not.toBeNull();
  return m as ScrollMetrics;
}

/** Ce qui reste de fil SOUS la zone visible : 0 au ras du bas. */
function distanceToBottom(m: ScrollMetrics): number {
  return m.scrollHeight - m.scrollTop - m.clientHeight;
}

/** La hauteur du bloc auquel appartient ce bouton, arrondie au pixel. */
async function blockHeight(row: Locator): Promise<number> {
  return row.evaluate((btn) => {
    const block = btn.parentElement;
    if (!block) throw new Error('le bouton de dépliage n’a pas de bloc parent');
    return Math.round(block.getBoundingClientRect().height);
  });
}

/**
 * Ouvre le fil semé et rend ses lignes de run, dans l'ordre. Le groupe s'ouvre
 * replié ou déplié selon la densité choisie par la personne (#132) : on lit
 * l'état plutôt que de le supposer, sans quoi ce parcours rougirait sur la
 * préférence de qui le lance.
 */
async function openThread(page: Page): Promise<Locator> {
  await page.goto(`/chat/${conversationId}`);
  const runRows = page.locator('[data-testid^="run-summary-"]');
  await expect(runRows.first(), 'le fil semé ne porte aucune ligne de run').toBeVisible();
  await expect(runRows, 'le fil semé porte deux travaux').toHaveCount(2);
  return runRows;
}

/**
 * Déplie le travail du premier run et rend la LIGNE de son appel d'outil,
 * repliée, amenée au milieu de la zone visible, avec du fil dessous.
 */
async function openTheFoldedToolRowInTheMiddle(page: Page): Promise<Locator> {
  const runRow = (await openThread(page)).first();
  if ((await runRow.getAttribute('aria-expanded')) !== 'true') {
    await runRow.click();
  }
  await expect(runRow).toHaveAttribute('aria-expanded', 'true');

  const toolRow = page.getByRole('button', { name: new RegExp(`${TOOL_NAME}.*probe 1`) });
  await expect(toolRow, `aucune ligne d’outil « ${TOOL_NAME} » pour le premier run`).toBeVisible();
  await expect(toolRow, 'la ligne d’outil devrait s’ouvrir REPLIÉE').toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // Au MILIEU de la zone visible. `scrollIntoView` n'est pas un geste du
  // lecteur au sens de #160 (aucun pointerdown) : il défile, et c'est tout.
  await toolRow.evaluate((btn) => btn.scrollIntoView({ block: 'center' }));
  // Laisser l'événement de défilement être distribué avant de mesurer.
  await page.waitForTimeout(300);
  return toolRow;
}

test.describe('déplier un bloc du fil @cap:parler-a-un-agent/ecran', () => {
  test('C — déplier DEPUIS LE BAS ne fait pas filer la zone visible', async ({ page }) => {
    // Le cas rapporté, et le seul que l'ancien comportement rate : le fil
    // s'ouvre EN BAS, donc le suivi est allumé. Avant #160, la croissance du
    // dépliage était suivie comme une arrivée, et la zone visible filait sous
    // le bloc qu'on venait d'ouvrir.
    const runRow = (await openThread(page)).last();
    await expect(runRow).toHaveAttribute('aria-expanded', 'false');

    const before = await scrollMetrics(page);
    expect(
      distanceToBottom(before),
      'le fil doit s’ouvrir EN BAS, sinon le suivi est déjà éteint et ce cas ne prouve rien',
    ).toBeLessThan(AT_BOTTOM_SLACK_PX);
    const beforeBox = await runRow.boundingBox();
    expect(beforeBox, 'la dernière ligne de run n’est pas à l’écran').not.toBeNull();

    await runRow.click();
    await expect(runRow).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(300);

    const after = await scrollMetrics(page);
    const afterBox = await runRow.boundingBox();
    expect(afterBox).not.toBeNull();
    const growth = after.scrollHeight - before.scrollHeight;
    expect(growth, 'le groupe déplié n’a pas grandi').toBeGreaterThan(100);

    // La position du lecteur, au pixel près. C'est LA promesse de #160.
    expect(after.scrollTop, 'le dépliage a déplacé le lecteur').toBe(before.scrollTop);
    // La ligne cliquée est restée exactement où elle était sous les yeux.
    expect(Math.round(afterBox!.y)).toBe(Math.round(beforeBox!.y));
    // Et toute la hauteur nouvelle est SOUS la zone visible.
    expect(distanceToBottom(after)).toBe(distanceToBottom(before) + growth);
  });

  test('A — depuis le milieu du fil, le dépliage grandit SOUS la zone visible', async ({
    page,
  }) => {
    const toolRow = await openTheFoldedToolRowInTheMiddle(page);

    const before = await scrollMetrics(page);
    const beforeBlock = await blockHeight(toolRow);
    const beforeBox = await toolRow.boundingBox();
    expect(beforeBox, 'la ligne d’outil n’est pas à l’écran').not.toBeNull();

    // Le fil n'est PAS en bas : c'est l'autre moitié de la promesse — un
    // dépliage ne doit pas non plus RALLUMER le suivi.
    expect(
      distanceToBottom(before),
      'la ligne d’outil doit être lisible AVEC du fil dessous',
    ).toBeGreaterThan(200);

    await toolRow.click();
    await expect(toolRow).toHaveAttribute('aria-expanded', 'true');
    // Le corps est bien là : c'est lui qui fait grandir le fil. Sa dernière
    // ligne, pas la première — un corps tronqué en porterait une sans l'autre.
    await expect(toolRow.locator('xpath=..')).toContainText('line 40');
    await page.waitForTimeout(300);

    const after = await scrollMetrics(page);
    const afterBlock = await blockHeight(toolRow);
    const afterBox = await toolRow.boundingBox();
    expect(afterBox).not.toBeNull();

    const growth = afterBlock - beforeBlock;
    // Un vrai dépliage, pas deux pixels de bordure.
    expect(growth, 'le bloc déplié n’a pas grandi').toBeGreaterThan(100);

    expect(after.scrollTop, 'le dépliage a déplacé le lecteur').toBe(before.scrollTop);
    expect(Math.round(afterBox!.y)).toBe(Math.round(beforeBox!.y));
    // Toute la hauteur nouvelle est partie SOUS la zone visible : la distance
    // au bas a grandi d'autant. Deux pixels de tolérance pour les arrondis de
    // `scrollHeight` (entier) face à un rectangle fractionnaire.
    expect(distanceToBottom(after) - distanceToBottom(before)).toBeGreaterThanOrEqual(growth - 2);
    expect(distanceToBottom(after) - distanceToBottom(before)).toBeLessThanOrEqual(growth + 2);
  });

  test('B — revenu en bas après un dépliage, le lecteur est de nouveau suivi', async ({ page }) => {
    const toolRow = await openTheFoldedToolRowInTheMiddle(page);

    // Le dépliage éteint le suivi : la position n'est plus en bas.
    await toolRow.click();
    await expect(toolRow).toHaveAttribute('aria-expanded', 'true');

    // Le lecteur redescend au bout du fil.
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
      if (el) el.scrollTop = el.scrollHeight;
    });
    const atBottom = await scrollMetrics(page);
    expect(distanceToBottom(atBottom)).toBeLessThan(AT_BOTTOM_SLACK_PX);

    // Passé la fenêtre du geste, une croissance redevient une ARRIVÉE. Le
    // mécanisme est celui de `thread-autoscroll.spec.ts` : faire grandir le
    // conteneur observé, qui est ce qu'un message qui arrive fait aussi.
    await page.waitForTimeout(AFTER_THE_GESTURE_MS);
    await page.evaluate(() => {
      const inner = document.querySelector<HTMLElement>('[data-thread-scroller]')
        ?.firstElementChild as HTMLElement | null;
      if (inner) inner.appendChild(document.createElement('div')).style.height = '900px';
    });
    await page.waitForTimeout(600);

    const after = await scrollMetrics(page);
    expect(after.scrollTop, 'le fil n’a pas suivi l’arrivée').toBeGreaterThan(atBottom.scrollTop);
    expect(
      distanceToBottom(after),
      'le lecteur revenu en bas doit être ramené en bas par une arrivée',
    ).toBeLessThan(AT_BOTTOM_SLACK_PX);
  });
});
