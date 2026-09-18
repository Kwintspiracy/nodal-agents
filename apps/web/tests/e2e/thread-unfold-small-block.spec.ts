/**
 * thread-unfold-small-block.spec.ts — une PETITE boîte dépliée ne fait pas
 * filer le fil, même une seconde plus tard.
 *
 * Ce que ce fichier prouve, et qu'aucun autre ne prouvait : la règle de Quentin
 * (« si je clique sur dérouler, la position du scroll ne DOIT PAS bouger »)
 * tenait pour les GROS blocs seulement. La PR #160 décidait du suivi d'après la
 * position du lecteur après la croissance, si bien qu'un bloc plus court que la
 * marge de 64 px le laissait « en bas », suivi allumé — et la croissance
 * suivante descendait le fil.
 *
 * Mesuré au navigateur le 18/09/2026, sur `/chat/[id]` comme sur
 * `/spaces/[id]`, aux mêmes chiffres : le bloc grandit de 58 px, le clic ne
 * déplace rien, puis `LiveRefresh` ramène une ligne 1,9 s plus tard et
 * `scrollTop` passe de 2459 à 2603 — la tête de la boîte qu'on venait d'ouvrir
 * remontant de 144 px.
 *
 * Deux cas, et le second est le prix du premier :
 *   A — la petite boîte dépliée depuis le bas, puis une arrivée TARDIVE : la
 *       position ne bouge pas, et la tête de la boîte reste au même endroit ;
 *   B — le lecteur redescend en bas : l'arrivée suivante le suit de nouveau.
 *       C'est le seul chemin qui rallume le suivi, et il faut qu'il marche.
 *
 * Aucun modèle n'est appelé : les lignes sont semées, comme dans les autres
 * parcours pilotés par la base, et tout est supprimé en `afterAll`.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { makeDbClient, requireLiveStack, resolveActingUser, testSlugSuffix } from './helpers.ts';

/**
 * Marge, en pixels, sous laquelle `ThreadScroller` considère qu'on est « en
 * bas ».
 *
 * ⚠️ COPIE de `AT_BOTTOM_SLACK_PX`, exporté par
 * `apps/web/src/app/(dashboard)/chat/[id]/ThreadScroller.tsx` : les deux
 * doivent rester égales. Recopiée plutôt qu'importée parce qu'un parcours
 * Playwright qui importerait un composant client tirerait React dans le
 * processus de test pour lire un nombre.
 */
const AT_BOTTOM_SLACK_PX = 64;

/**
 * Le délai après lequel une croissance n'est plus le geste du lecteur
 * (`READER_GESTURE_WINDOW_MS`, 800 ms). On attend franchement au-delà : c'est
 * là, et seulement là, que le défaut se produisait.
 */
const AFTER_THE_GESTURE_MS = 1_900;

const TOOL_NAME = 'e2e_small_block';

/** La densité sous laquelle ces cas ont un sens — voir le fichier voisin. */
const DENSITY_FOR_THESE_CASES = 'folded';

let acting: { userId: string; entityId: string };
let seeded: { conversationId: string; agentId: string };
let densityBefore: string | null = null;
const created: { jobIds: string[]; conversationIds: string[]; agentIds: string[] } = {
  jobIds: [],
  conversationIds: [],
  agentIds: [],
};

test.beforeAll(async () => {
  await requireLiveStack();
  acting = await resolveActingUser();
  densityBefore = await setFeedDensity(DENSITY_FOR_THESE_CASES);
  seeded = await seedLiveThreadWithASmallBlock();
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
  if (densityBefore !== null) await setFeedDensity(densityBefore);
});

/** Pose la densité de lecture de la personne, et rend celle qu'elle avait. */
async function setFeedDensity(density: string): Promise<string | null> {
  const { users, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .select({ density: users.feedDensity })
      .from(users)
      .where(eq(users.id, acting.userId))
      .limit(1);
    if (row === undefined) return null;
    if (row.density !== density) {
      await db.update(users).set({ feedDensity: density }).where(eq(users.id, acting.userId));
    }
    return row.density;
  } finally {
    await close();
  }
}

/**
 * Un fil dont le travail COURT — c'est ce qui allume `LiveRefresh` — et dont
 * l'appel d'outil a un corps d'UNE LIGNE.
 *
 * La carte `generic` fait rendre `StepLine` en une ligne, sans plaque de code,
 * et une entrée vide ne donne rien à citer : le corps tient alors sous la marge
 * de 64 px, ce qui est TOUTE la condition du défaut. Un appel d'outil dont la
 * carte est lue ressemble exactement à ça dans un vrai fil.
 */
async function seedLiveThreadWithASmallBlock(): Promise<{
  conversationId: string;
  agentId: string;
}> {
  const { agents, agentJobs, chatMessages, conversations, toolCalls } =
    await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  const suffix = testSlugSuffix();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: `E2E Small ${suffix}`,
        slug: `e2e-small-${suffix}`,
        // NOT NULL sans défaut, et jamais lu : aucun modèle ne tourne ici.
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
        title: `Small block ${suffix}`,
        origin: 'user',
        channel: 'dashboard',
      })
      .returning({ id: conversations.id });
    created.conversationIds.push(conversation!.id);

    const t0 = Date.now() - 600_000;
    const at = (s: number): Date => new Date(t0 + s * 1_000);
    const toolCallId = `small_${suffix}`;

    const [head] = await db
      .insert(agentJobs)
      .values({
        entityId: acting.entityId,
        agentId: agent!.id,
        conversationId: conversation!.id,
        channel: 'dashboard',
        task: 'Keep working',
        // PAS terminal : `live` s'allume, donc LiveRefresh relit la page.
        status: 'processing',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Working.' },
              { type: 'tool-call', toolName: TOOL_NAME, toolCallId, args: {} },
            ],
          },
        ],
        createdAt: at(1),
      })
      .returning({ id: agentJobs.id });
    created.jobIds.push(head!.id);

    await db.insert(toolCalls).values({
      entityId: acting.entityId,
      jobId: head!.id,
      toolName: TOOL_NAME,
      toolCallId,
      toolInput: {},
      toolOutput: 'ok',
      card: 'generic',
      presented: { card: 'generic' },
      durationMs: 900,
      turn: 1,
      createdAt: at(2),
    });

    type Row = {
      entityId: string;
      agentId: string;
      conversationId: string;
      role: 'user' | 'assistant';
      content: string;
      jobId?: string;
      createdAt: Date;
    };
    const rows: Row[] = [
      {
        entityId: acting.entityId,
        agentId: agent!.id,
        conversationId: conversation!.id,
        role: 'user',
        content: 'Keep working.',
        createdAt: at(0),
      },
    ];
    // De la prose devant, pour que le fil déborde et s'ouvre vraiment en bas.
    for (let i = 0; i < 8; i++) {
      rows.push({
        entityId: acting.entityId,
        agentId: agent!.id,
        conversationId: conversation!.id,
        role: 'assistant',
        content: Array.from(
          { length: 8 },
          (_, l) => `Filler ${i + 1}, line ${l + 1}: prose that gives the thread height.`,
        ).join('\n\n'),
        createdAt: at(1 + i * 0.01),
      });
    }
    rows.push({
      entityId: acting.entityId,
      agentId: agent!.id,
      conversationId: conversation!.id,
      role: 'assistant',
      content: 'On it.',
      jobId: head!.id,
      createdAt: at(3),
    });
    await db.insert(chatMessages).values(rows);

    return { conversationId: conversation!.id, agentId: agent!.id };
  } finally {
    await close();
  }
}

/** Le travail avance d'une ligne — c'est elle que LiveRefresh ramènera. */
async function addATurn(): Promise<void> {
  const { chatMessages } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    await db.insert(chatMessages).values({
      entityId: acting.entityId,
      agentId: seeded.agentId,
      conversationId: seeded.conversationId,
      role: 'assistant',
      content: 'A new line arrived while you were reading.',
      createdAt: new Date(),
    });
  } finally {
    await close();
  }
}

type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

async function scrollMetrics(page: Page): Promise<ScrollMetrics> {
  const m = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
    if (!el) return null;
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
  expect(m, 'le fil ne porte pas [data-thread-scroller]').not.toBeNull();
  return m as ScrollMetrics;
}

function distanceToBottom(m: ScrollMetrics): number {
  return m.scrollHeight - m.scrollTop - m.clientHeight;
}

/** Les mesures une fois la géométrie POSÉE : deux relevés consécutifs égaux. */
async function settledMetrics(page: Page): Promise<ScrollMetrics> {
  let previous: ScrollMetrics | null = null;
  let current: ScrollMetrics | null = null;
  await expect
    .poll(
      async () => {
        previous = current;
        current = await scrollMetrics(page);
        return (
          previous !== null &&
          previous.scrollHeight === current.scrollHeight &&
          previous.scrollTop === current.scrollTop
        );
      },
      { timeout: 10_000, intervals: [50, 50, 100, 100, 200, 250] },
    )
    .toBe(true);
  return current as unknown as ScrollMetrics;
}

/**
 * Ouvre le fil, déplie le groupe du run, ramène le lecteur EN BAS, et rend la
 * ligne de l'appel d'outil — repliée, et petite.
 */
async function openAtTheSmallBlock(page: Page): Promise<Locator> {
  await page.goto(`/chat/${seeded.conversationId}`);
  const runRow = page.locator('[data-testid^="run-summary-"]').first();
  await expect(runRow, 'le fil semé ne porte aucune ligne de run').toBeVisible();
  if ((await runRow.getAttribute('aria-expanded')) !== 'true') {
    await runRow.click();
  }
  await expect(runRow).toHaveAttribute('aria-expanded', 'true');

  // Le lecteur est EN BAS quand il ouvre une boîte : c'est là que le suivi est
  // allumé, et donc le seul endroit où ce cas prouve quelque chose.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
    if (el) el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(async () => distanceToBottom(await scrollMetrics(page)), { timeout: 10_000 })
    .toBeLessThan(AT_BOTTOM_SLACK_PX);

  const toolRow = page.getByRole('button', { name: new RegExp(TOOL_NAME) });
  await expect(toolRow, `aucune ligne d’outil « ${TOOL_NAME} »`).toBeVisible();
  await expect(toolRow, 'la ligne d’outil devrait s’ouvrir REPLIÉE').toHaveAttribute(
    'aria-expanded',
    'false',
  );
  return toolRow;
}

test.describe('déplier une PETITE boîte @cap:parler-a-un-agent/ecran', () => {
  test('A — une arrivée TARDIVE ne déplace pas le lecteur qui vient d’ouvrir', async ({ page }) => {
    const toolRow = await openAtTheSmallBlock(page);
    const before = await settledMetrics(page);
    const headBefore = await toolRow.boundingBox();
    expect(headBefore, 'la ligne d’outil n’est pas à l’écran').not.toBeNull();

    await toolRow.click();
    await expect(toolRow).toHaveAttribute('aria-expanded', 'true');
    const afterBox = await settledMetrics(page);
    const headAfterBox = await toolRow.boundingBox();

    // LA CONDITION du défaut : le bloc est PLUS COURT que la marge. Sans elle,
    // ce cas retomberait sur celui que `thread-unfold-keeps-scroll` couvre
    // déjà, et ne prouverait rien de neuf.
    const growth = afterBox.scrollHeight - before.scrollHeight;
    expect(growth, 'le bloc n’a pas grandi').toBeGreaterThan(0);
    expect(
      growth,
      'le bloc doit rester sous la marge, sinon ce cas ne prouve pas ce qu’il dit',
    ).toBeLessThan(AT_BOTTOM_SLACK_PX);
    // Le dépliage lui-même ne déplace rien — c'était déjà vrai.
    expect(afterBox.scrollTop).toBe(before.scrollTop);

    // Puis le fil grandit de nouveau, HORS de la fenêtre du geste : c'est
    // exactement le rafraîchissement qui descendait le lecteur.
    await page.waitForTimeout(AFTER_THE_GESTURE_MS);
    await addATurn();
    await expect
      .poll(async () => (await scrollMetrics(page)).scrollHeight, { timeout: 15_000 })
      .toBeGreaterThan(afterBox.scrollHeight);
    const afterArrival = await settledMetrics(page);
    const headAfterArrival = await toolRow.boundingBox();

    // LES DEUX ASSERTIONS DE CE FICHIER.
    expect(
      afterArrival.scrollTop,
      'une arrivée a descendu le fil alors que le lecteur venait d’ouvrir une boîte',
    ).toBe(before.scrollTop);
    expect(
      Math.round(headAfterArrival!.y),
      'la boîte ouverte a remonté sous les yeux du lecteur',
    ).toBe(Math.round(headBefore!.y));
    // Et la boîte n'avait pas bougé non plus au moment du clic.
    expect(Math.round(headAfterBox!.y)).toBe(Math.round(headBefore!.y));
  });

  test('B — revenu en bas, le lecteur est de nouveau suivi', async ({ page }) => {
    // Le prix du cas A, et il faut qu'il se paie : le suivi ne se rallume plus
    // que par le retour en bas. Si ce chemin ne marchait pas, une petite boîte
    // ouverte une fois éteindrait le suivi pour de bon.
    const toolRow = await openAtTheSmallBlock(page);
    await toolRow.click();
    await expect(toolRow).toHaveAttribute('aria-expanded', 'true');
    await settledMetrics(page);

    // Le lecteur redescend au bout du fil.
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-thread-scroller]');
      if (el) el.scrollTop = el.scrollHeight;
    });
    const atBottom = await settledMetrics(page);
    expect(distanceToBottom(atBottom)).toBeLessThan(AT_BOTTOM_SLACK_PX);

    await page.waitForTimeout(AFTER_THE_GESTURE_MS);
    await addATurn();

    // D'ABORD attendre que l'arrivée SOIT LÀ. Mesurer « on est en bas » avant
    // elle ne dirait rien : on y était déjà, et la condition serait vraie sans
    // que rien n'ait été suivi.
    await expect
      .poll(async () => (await scrollMetrics(page)).scrollHeight, { timeout: 15_000 })
      .toBeGreaterThan(atBottom.scrollHeight);
    const after = await settledMetrics(page);

    expect(after.scrollTop, 'le fil n’a pas suivi l’arrivée').toBeGreaterThan(atBottom.scrollTop);
    expect(
      distanceToBottom(after),
      'le lecteur revenu en bas doit être ramené en bas par une arrivée',
    ).toBeLessThan(AT_BOTTOM_SLACK_PX);
  });
});
