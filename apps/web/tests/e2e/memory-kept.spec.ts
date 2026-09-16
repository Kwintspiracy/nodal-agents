/**
 * A fact taught on the screen is still there on the next visit, and findable.
 *
 * This is the SCREEN half of "Remember", and only that half. It proves that a
 * fact the user records is written, survives a fresh page load, comes back
 * through the search box, and leaves the agent's context when archived. It
 * proves nothing about an agent calling `save_memory` or `query_memory` on its
 * own: that is the ENGINE half, and it lives in `packages/memory`
 * (`inject.test.ts`, `search.test.ts`), where no LLM is needed either.
 *
 * It replaces the memory scenarios of the old `agent-flows.spec.ts` (issue
 * #110), which asked a real model to decide to save a memory and could only
 * ever run against an LM Studio server on one machine. A journey nobody can
 * play proves nothing at all.
 *
 * No model is involved. The search box drives the same `search_tsv` / `ts_rank`
 * engine the agent's `query_memory` tool uses, so "the fact is findable again"
 * is a real lookup, not a client-side substring match on rows already loaded.
 *
 * That last sentence used to be a claim, not a fact. `MemoriesClient` filters
 * the already-loaded page by substring INSTANTLY and only calls
 * `searchMemoriesAction` after a 300ms debounce, so a query that is a literal
 * substring of the fact is answered by the client before the server is even
 * asked: breaking the server search left this journey green (review of PR
 * #113). The query below is an INFLECTED form the fact does not contain, which
 * only Postgres' `english` stemming can match — the substring filter returns
 * nothing for it, so a broken server search now turns this journey red. The
 * engine side of the same proof, including that mutation, lives in
 * `apps/web/tests/memories-search-is-server-side.test.tsx`, and the stemming
 * itself in `packages/memory/src/tests/search.test.ts`.
 *
 * Every row created is deleted in afterAll.
 */

import { test, expect, type Page } from '@playwright/test';
import { makeDbClient, requireLiveStack, resolveActingUser, testSlugSuffix } from './helpers.ts';

/** Written into every fact so the cleanup can find exactly what this file made. */
const MARK = `e2e-memory-${testSlugSuffix()}`;

/** The word the fact contains, in the singular. */
const WORD_IN_THE_FACT = 'clarinet';

/**
 * The word the search box is given: the PLURAL, which appears nowhere in the
 * fact. `to_tsquery('english', 'clarinets')` stems to the same lexeme as the
 * stored `clarinet`, so the server finds the row; the page's instant substring
 * filter cannot, because 'clarinets' is not a substring of anything on screen.
 * That gap is the whole point — it is what makes this assertion fail when the
 * server search is broken instead of quietly falling back to the client.
 *
 * Proven at the engine level in `packages/memory/src/tests/search.test.ts`
 * ("plural query finds the singular fact"), so this journey is not betting on
 * an assumption about the stemmer.
 */
const SEARCHED_WORD = 'clarinets';

const FACT = `Quentin plays the ${WORD_IN_THE_FACT} on Sunday mornings. [${MARK}]`;
/** A second fact, so "the search filters" means something: one row in, one out. */
const OTHER_FACT = `Quentin bakes sourdough on Saturdays. [${MARK}]`;

test.beforeAll(async () => {
  await requireLiveStack();
});

test.afterAll(async () => {
  const { agentMemory, like, and, eq } = await import('@nodal-agents/db');
  // Scoped to the acting entity, not just the marker. A `like` alone reaches
  // every entity in the database, and this file runs against whatever stack is
  // in front of it — a cleanup has no business deleting another tenant's rows,
  // however unlikely the collision (review of PR #113).
  const { entityId } = await resolveActingUser();
  const { db, close } = makeDbClient();
  try {
    await db
      .delete(agentMemory)
      .where(and(eq(agentMemory.entityId, entityId), like(agentMemory.fact, `%${MARK}%`)));
  } finally {
    await close();
  }
});

/** Record one fact through the New Memory modal, the way a user does. */
async function recordFact(page: Page, fact: string): Promise<void> {
  await page.getByRole('button', { name: '+ New Memory' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  await modal.locator('#memory-fact').fill(fact);
  await modal.getByRole('button', { name: 'Save memory' }).click();
  // The modal is not dismissable: it closes only once the write succeeded.
  await expect(modal).toBeHidden();
}

test.describe('a fact taught on the screen is kept @cap:se-souvenir/ecran', () => {
  test('it is written, it survives a reload, and the search finds it again', async ({ page }) => {
    await page.goto('/memories');
    await recordFact(page, FACT);
    await recordFact(page, OTHER_FACT);

    // 1. Both facts are on screen straight away.
    await expect(page.getByText(FACT, { exact: false })).toBeVisible();
    await expect(page.getByText(OTHER_FACT, { exact: false })).toBeVisible();

    // 2. They survive a FULL reload — the page is server-rendered from the
    //    database, so this is the row talking, not React state.
    await page.reload();
    await expect(page.getByText(FACT, { exact: false })).toBeVisible();

    // 3. Asked for later, the fact comes back — and it can ONLY come back from
    //    the server. `clarinets` is not a substring of either fact, so the
    //    page's instant client filter shows an empty table until the FTS
    //    roundtrip lands; if `searchMemoriesAction` fails, it stays empty and
    //    this assertion times out. That is the mutation this journey now has.
    await page.getByPlaceholder('Search memories…').fill(SEARCHED_WORD);
    await expect(page.getByText(FACT, { exact: false })).toBeVisible();
    // And the other fact is gone: a search that returns everything has found
    // nothing.
    await expect(page.getByText(OTHER_FACT, { exact: false })).toHaveCount(0);
  });

  test('archiving a fact takes it out of what the agent is given', async ({ page }) => {
    const archived = `Quentin drives a diesel van. [${MARK}]`;
    await page.goto('/memories');
    await recordFact(page, archived);

    const row = page.locator('tr', { hasText: archived });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Archive' }).click();

    // Gone from "All", which is what the agent reads: the Archived tab says
    // so in as many words, and the row is waiting there, not deleted.
    await expect(page.getByText(archived, { exact: false })).toHaveCount(0);
    await expect(page.getByText('excluded from agent context')).toBeVisible();
    await page.getByRole('tab', { name: /Archived/ }).click();
    await expect(page.getByText(archived, { exact: false })).toBeVisible();
  });
});
