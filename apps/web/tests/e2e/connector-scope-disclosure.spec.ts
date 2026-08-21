/**
 * Playwright e2e — CONNECTOR-001: how far a connector's token reaches is stated
 * BEFORE the provider's consent screen.
 *
 * Four Google connectors request the broadest scope in their family because
 * their tools genuinely need it: `drive.file` cannot open a file the user
 * already has, and the `.readonly` variants cannot write. That scope is
 * defensible. Letting "connect Google Drive" read as "the files it needs" is
 * not — so the product says the reach out loud, in its own words, while the
 * user can still walk away.
 *
 * Unit tests already pin the data (packages/shared oauth-scopes.test.ts fails if
 * a blanket scope carries no disclosure). What they cannot show is whether the
 * sentence ever reaches a screen. That is this file's whole job.
 *
 * Written after `oauth-flow.spec.ts` was found chasing `.rounded-xl` on a card
 * that renders `rounded-2xl` — one character, and the suite had been reporting a
 * missing Google Drive card ever since the connectors redesign. Selectors here
 * are anchored on ROLES and TEXT, never on utility classes.
 */

import { test, expect, type Page } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 60_000 });

/** Open a connector's install dialog from the marketplace grid. */
async function openConnectorDialog(page: Page, label: string): Promise<void> {
  await page.goto('/connectors');
  await page.waitForLoadState('networkidle', { timeout: 15_000 });

  // The catalogue lives behind the "Library" tab — the page opens on
  // "Installed", where none of these cards exist yet. Measured, not assumed:
  // the freshly loaded page contains ZERO <h3>, so any locator hunting for a
  // card heading finds nothing and reports the connector as missing. That is
  // the real reason oauth-flow.spec.ts has been claiming Google Drive
  // disappeared (its stale `.rounded-xl` filter was only the second problem).
  // NOT /^library$/ — the DS Tabs primitive folds a count into the tab label,
  // so the accessible name is "Library · 15" and grows with the catalogue. An
  // anchored match would break the day a connector is added.
  await page.getByRole('tab', { name: /library/i }).click();

  const card = page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: label, level: 3 }) })
    .last();
  await expect(card, `no marketplace card for ${label}`).toBeVisible({ timeout: 15_000 });

  // "Install" on a fresh connector, "Add account" once one exists — the same
  // button either way (MarketplaceCardActions).
  await card.getByRole('button', { name: /^(install|add account)$/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
}

test.describe('Connector scope disclosure', () => {
  test('Google Drive states it reaches the ENTIRE Drive', async ({ page }) => {
    await openConnectorDialog(page, 'Google Drive');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/what this connector can reach/i)).toBeVisible({
      timeout: 10_000,
    });
    // The specific claim, not just the heading: an owner must read that this is
    // every file, not only the ones agents create.
    await expect(dialog.getByText(/entire google drive/i)).toBeVisible();
  });

  test('Google Sheets and Docs disclose their reach too', async ({ page }) => {
    for (const label of ['Google Sheets', 'Google Docs']) {
      await openConnectorDialog(page, label);
      await expect(
        page.getByRole('dialog').getByText(/what this connector can reach/i),
        `${label} shows no disclosure`,
      ).toBeVisible({ timeout: 10_000 });
      await page.getByRole('dialog').getByRole('button', { name: /cancel/i }).click();
    }
  });

  test('a connector whose reach matches its name shows NO disclosure', async ({ page }) => {
    // Gmail asks only for readonly + send, which is what "connect Gmail" already
    // implies. A banner there would be noise, and noise is what teaches people
    // to skip the banner that matters.
    await openConnectorDialog(page, 'Gmail');
    await expect(page.getByRole('dialog').getByText(/what this connector can reach/i)).toHaveCount(
      0,
    );
  });
});
