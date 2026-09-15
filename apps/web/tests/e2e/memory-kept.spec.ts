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
 * Every row created is deleted in afterAll.
 */

import { test, expect, type Page } from '@playwright/test';
import { makeDbClient, requireLiveStack, testSlugSuffix } from './helpers.ts';

/** Written into every fact so the cleanup can find exactly what this file made. */
const MARK = `e2e-memory-${testSlugSuffix()}`;

/**
 * The word the search box is given. A real English word, not the marker: the
 * lookup runs through `to_tsquery('english', …)`, which stems its input, and a
 * hyphenated identifier would not survive that stemming. Searching for a token
 * the engine cannot tokenize would make the test green on an empty result.
 */
const SEARCHED_WORD = 'clarinet';

const FACT = `Quentin plays the ${SEARCHED_WORD} on Sunday mornings. [${MARK}]`;
/** A second fact, so "the search filters" means something: one row in, one out. */
const OTHER_FACT = `Quentin bakes sourdough on Saturdays. [${MARK}]`;

test.beforeAll(async () => {
  await requireLiveStack();
});

test.afterAll(async () => {
  const { agentMemory, like } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    await db.delete(agentMemory).where(like(agentMemory.fact, `%${MARK}%`));
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

    // 3. Asked for later, the fact comes back. The query goes to the server's
    //    full-text search, the same engine `query_memory` runs on.
    await page.getByPlaceholder('Search memories…').fill(SEARCHED_WORD);
    await expect(page.getByText(FACT, { exact: false })).toBeVisible();
    // And the other fact is gone: a search that returns everything has found
    // nothing. This is the assertion that fails if the lookup is a no-op.
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
