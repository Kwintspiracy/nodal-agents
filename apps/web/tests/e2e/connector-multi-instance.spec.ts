/**
 * connector-multi-instance.spec.ts — e2e regression for the multi-instance connectors brique.
 *
 * Guards that the UNIQUE(entity_id, slug) constraint was dropped on `connectors`
 * and that the UI correctly supports creating two instances of the same api_key
 * connector type.
 *
 * Connector under test: `tavily` (api_key, no external verify call)
 *
 * Steps:
 *  1. Navigate to /connectors.
 *  2. In the Marketplace, click "+ Add" on Tavily.
 *  3. Fill name="Tavily — perso", apiKey="test-key-1". Submit.
 *  4. Wait for success toast + Active Connectors list update.
 *  5. Click "+ Add" on Tavily again.
 *  6. Fill name="Tavily — boulot", apiKey="test-key-2". Submit.
 *  7. Wait for success toast + Active Connectors list update.
 *  8. Assert BOTH instances appear in Active Connectors by name.
 *  9. (Bonus) Delete both, assert the empty-state message returns.
 *
 * Requires a running Nodal-Agents stack (port 3000). Skipped if not reachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

const CONNECTOR_LABEL = 'Tavily';
const INSTANCE_A = 'Tavily — perso';
const INSTANCE_B = 'Tavily — boulot';
const API_KEY_A = 'test-tavily-key-perso-1234';
const API_KEY_B = 'test-tavily-key-boulot-5678';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 60_000 });

test.describe('Connector multi-instance', () => {
  test('can create two instances of the same api_key connector and both appear in Active Connectors', async ({
    page,
  }) => {
    // ── 0. Pre-cleanup: delete any leftover instances from a prior run ──────────
    await page.goto('/connectors');
    await page.waitForLoadState('networkidle');

    // Helper: delete a named active connector if it exists.
    async function deleteIfPresent(name: string) {
      const activeSectionEl = page.locator('section').filter({
        has: page.getByRole('heading', { name: 'Active Connectors', level: 2 }),
      });
      if (!(await activeSectionEl.isVisible().catch(() => false))) return;

      // Use exact: true + first() to avoid strict-mode errors when multiple instances exist.
      const instanceCard = activeSectionEl
        .locator('.rounded-xl')
        .filter({ has: page.getByRole('heading', { name, level: 3, exact: true }) })
        .first();

      if (!(await instanceCard.isVisible().catch(() => false))) return;

      const deleteBtn = instanceCard.getByRole('button', { name: /^delete$/i });
      if (!(await deleteBtn.isVisible().catch(() => false))) return;

      await deleteBtn.click();
      // ConfirmDialog appears — click the confirm button (labelled "Delete")
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      await dialog.getByRole('button', { name: /^delete$/i }).click();
      await expect(page.getByText(`${name} removed`)).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
    }

    await deleteIfPresent(INSTANCE_A);
    await deleteIfPresent(INSTANCE_B);

    // Reload so the page reflects the clean state.
    await page.reload();
    await page.waitForLoadState('networkidle');

    // ── 1. Find the Tavily Marketplace card ─────────────────────────────────────
    // Scope to the Marketplace <section> so we never accidentally match Active
    // Connector cards whose names start with "Tavily — …" (substring match).
    const marketplaceSection = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Marketplace', level: 2 }),
    });

    await expect(marketplaceSection).toBeVisible({ timeout: 10_000 });

    // Within Marketplace, pick the card whose h3 is exactly "Tavily".
    const marketplaceCard = marketplaceSection
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: CONNECTOR_LABEL, level: 3, exact: true }) });

    await expect(marketplaceCard).toBeVisible({ timeout: 10_000 });

    // ── 2. Add first instance ────────────────────────────────────────────────────
    await marketplaceCard.getByRole('button', { name: /^\+ add$/i }).click();

    const nameInputA = marketplaceCard.locator('input[name="name"]');
    const apiKeyInputA = marketplaceCard.locator('input[name="apiKey"]');

    await expect(nameInputA).toBeVisible({ timeout: 5_000 });
    await expect(apiKeyInputA).toBeVisible({ timeout: 5_000 });

    await nameInputA.fill(INSTANCE_A);
    await apiKeyInputA.fill(API_KEY_A);

    await marketplaceCard.getByRole('button', { name: /^connect$/i }).click();

    // Toast: "{name} connected"
    await expect(page.getByText(`${INSTANCE_A} connected`)).toBeVisible({ timeout: 10_000 });

    // Wait for form to close (open = false after success).
    await expect(nameInputA).not.toBeVisible({ timeout: 5_000 });

    // ── 3. Page reload to reflect the new Active Connector ───────────────────────
    // The connectors page is force-dynamic but the active list is rendered
    // server-side; a reload is the canonical way to see DB changes.
    await page.reload();
    await page.waitForLoadState('networkidle');

    // ── 4. Add second instance ───────────────────────────────────────────────────
    // The Marketplace card is still present (multi-instance: never disappears).
    // Re-query the marketplace section after reload.
    const marketplaceSectionB = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Marketplace', level: 2 }),
    });
    const marketplaceCardB = marketplaceSectionB
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: CONNECTOR_LABEL, level: 3, exact: true }) });

    await expect(marketplaceCardB).toBeVisible({ timeout: 10_000 });
    await marketplaceCardB.getByRole('button', { name: /^\+ add$/i }).click();

    const nameInputB = marketplaceCardB.locator('input[name="name"]');
    const apiKeyInputB = marketplaceCardB.locator('input[name="apiKey"]');

    await expect(nameInputB).toBeVisible({ timeout: 5_000 });
    await expect(apiKeyInputB).toBeVisible({ timeout: 5_000 });

    await nameInputB.fill(INSTANCE_B);
    await apiKeyInputB.fill(API_KEY_B);

    await marketplaceCardB.getByRole('button', { name: /^connect$/i }).click();

    await expect(page.getByText(`${INSTANCE_B} connected`)).toBeVisible({ timeout: 10_000 });
    await expect(nameInputB).not.toBeVisible({ timeout: 5_000 });

    // ── 5. Reload and assert BOTH instances appear in Active Connectors ──────────
    await page.reload();
    await page.waitForLoadState('networkidle');

    const activeSection = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Active Connectors', level: 2 }),
    });

    await expect(activeSection).toBeVisible({ timeout: 10_000 });

    // Both instance names should appear inside the active section.
    await expect(activeSection.getByRole('heading', { name: INSTANCE_A, level: 3 })).toBeVisible({
      timeout: 10_000,
    });

    await expect(activeSection.getByRole('heading', { name: INSTANCE_B, level: 3 })).toBeVisible({
      timeout: 10_000,
    });

    // ── 6. (Bonus) Delete both instances — cleanup ───────────────────────────────
    async function deleteActiveConnector(name: string) {
      // Re-locate inside activeSection each time since the DOM updates after
      // each deletion (React removes the card from the list).
      const sectionLoc = page.locator('section').filter({
        has: page.getByRole('heading', { name: 'Active Connectors', level: 2 }),
      });
      const card = sectionLoc
        .locator('.rounded-xl')
        .filter({ has: page.getByRole('heading', { name, level: 3, exact: true }) })
        .first();

      await card.getByRole('button', { name: /^delete$/i }).click();

      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      await dialog.getByRole('button', { name: /^delete$/i }).click();

      await expect(page.getByText(`${name} removed`)).toBeVisible({ timeout: 10_000 });
      // Wait for optimistic UI to settle before deleting the next one.
      await page.waitForTimeout(300);
    }

    await deleteActiveConnector(INSTANCE_A);
    await deleteActiveConnector(INSTANCE_B);

    // After both deletions, reload and verify neither test instance is present.
    // NOTE: other connectors from the e2e user may still exist — we only assert
    // that OUR two test instances are gone, not the global empty state.
    await page.reload();
    await page.waitForLoadState('networkidle');

    const activeSectionAfter = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Active Connectors', level: 2 }),
    });

    await expect(
      activeSectionAfter.getByRole('heading', { name: INSTANCE_A, level: 3, exact: true }),
    ).not.toBeVisible({ timeout: 10_000 });

    await expect(
      activeSectionAfter.getByRole('heading', { name: INSTANCE_B, level: 3, exact: true }),
    ).not.toBeVisible({ timeout: 10_000 });
  });
});
