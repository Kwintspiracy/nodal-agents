/**
 * webhooks-flows.spec.ts
 *
 * Full click-through of the "Webhooks" section on /automations (Brique 5 —
 * inbound webhooks, UI half). Covers: create → URL panel with copy button →
 * toggle off/on → rotate secret (ConfirmDialog) → delete (ConfirmDialog) →
 * empty state.
 *
 * Conventions:
 *  - requireLiveStack() in beforeAll — skip if stack unreachable.
 *  - storageState loaded by playwright.config.ts — no manual login.
 *  - Selectors: getByRole / getByLabel / getByText preferred.
 *  - Screenshots at each step for manual review.
 *  - Cleanup (best-effort): delete the webhook created by this spec at the end.
 */

import { test, expect, type Page } from '@playwright/test';
import { requireLiveStack, testSlugSuffix } from './helpers.ts';

const WEBHOOK_NAME = `Webhook E2E ${testSlugSuffix()}`;
const SCREENSHOT_DIR =
  'C:/Users/kwint/AppData/Local/Temp/claude/D--APPS-NodalAI/651bec26-399e-402d-bfb9-a06254eed9e3/scratchpad/b5-ui-check';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 90_000 });

test.describe('Webhooks section — full click flow', () => {
  test('create, copy URL, toggle, rotate, delete, empty state', async ({ page }) => {
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-automations-initial.png`, fullPage: true });

    // Pre-cleanup: remove any leftover from a prior aborted run.
    await deleteWebhookIfPresent(page, WEBHOOK_NAME);

    // Was the Webhooks list empty BEFORE this test ran? Used at the end to
    // decide whether the empty state must reappear (a real dev entity may
    // already have other webhooks — the assertion must not assume a vacuum).
    const initiallyEmpty = await page.getByText(/no webhooks yet/i).isVisible();

    // ── Open the "+ New webhook" form ────────────────────────────────────────
    await page.getByRole('button', { name: /new webhook/i }).click();
    await expect(page.getByRole('heading', { name: /^new webhook$/i })).toBeVisible({
      timeout: 5_000,
    });

    const agentSelect = page.locator('#webhook-agent');
    await expect(agentSelect).toBeVisible({ timeout: 5_000 });
    const agentOptions = await agentSelect.locator('option').all();
    let firstAgentValue: string | null = null;
    for (const opt of agentOptions) {
      const v = await opt.getAttribute('value');
      if (v && v.trim() !== '') {
        firstAgentValue = v;
        break;
      }
    }
    if (!firstAgentValue) {
      test.skip(true, 'No agents available in the e2e entity — cannot test webhooks');
      return;
    }
    await agentSelect.selectOption(firstAgentValue);
    await page.locator('#webhook-name').fill(WEBHOOK_NAME);
    await page.locator('#webhook-task').fill('A pull request was opened: {pull_request.title}');
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-webhook-form-filled.png`, fullPage: true });

    await page.getByRole('button', { name: /^create webhook$/i }).click();

    // ── Success toast + success panel with the full URL ─────────────────────
    await expect(page.getByText(/^webhook created$/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: /^webhook created$/i })).toBeVisible({
      timeout: 5_000,
    });
    const successPanel = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: /^webhook created$/i }) });
    await expect(successPanel).toBeVisible();
    const successUrlText = await successPanel.locator('.font-mono').first().textContent();
    expect(successUrlText).toMatch(/^https?:\/\/.+:3001\/webhooks\/.+\/[0-9a-f]{32}$/);
    await expect(successPanel.getByRole('button', { name: /^copy$/i })).toBeVisible();
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-create-success-panel.png`,
      fullPage: true,
    });

    // Copy button works (clipboard write does not throw / shows a toast).
    await successPanel.getByRole('button', { name: /^copy$/i }).click();
    await expect(page.getByText(/^copied$/i)).toBeVisible({ timeout: 5_000 });

    await successPanel.getByRole('button', { name: /^done$/i }).click();

    // ── The row now appears in the list, still revealing the URL this session ──
    const webhookCard = page.locator('.rounded-xl').filter({
      has: page.getByRole('heading', { name: WEBHOOK_NAME }),
    });
    await expect(webhookCard).toBeVisible({ timeout: 10_000 });
    await expect(webhookCard.getByText(/webhook url/i)).toBeVisible({ timeout: 5_000 });
    await expect(webhookCard.getByRole('button', { name: /^copy$/i })).toBeVisible();
    await expect(webhookCard.getByText(/0 fires/i)).toBeVisible();
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-webhook-row-revealed.png`,
      fullPage: true,
    });

    // ── Toggle off / on ───────────────────────────────────────────────────────
    await webhookCard.getByRole('button', { name: /^pause$/i }).click();
    await expect(page.getByText(/webhook disabled/i)).toBeVisible({ timeout: 10_000 });
    await expect(webhookCard.getByText(/^paused$/i)).toBeVisible({ timeout: 5_000 });

    await webhookCard.getByRole('button', { name: /^enable$/i }).click();
    await expect(page.getByText(/webhook enabled/i)).toBeVisible({ timeout: 10_000 });
    await expect(webhookCard.getByText(/^active$/i)).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-webhook-toggled.png`, fullPage: true });

    // ── Rotate secret (ConfirmDialog) ────────────────────────────────────────
    const urlBefore = await webhookCard.locator('.font-mono').first().textContent();
    await webhookCard.getByRole('button', { name: /^rotate$/i }).click();
    const rotateDialog = page.getByRole('dialog');
    await expect(rotateDialog).toBeVisible({ timeout: 5_000 });
    await expect(rotateDialog.getByText(/rotate webhook secret/i)).toBeVisible();
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-rotate-confirm-dialog.png`,
      fullPage: true,
    });
    await rotateDialog.getByRole('button', { name: /^rotate$/i }).click();

    await expect(page.getByText(/secret rotated/i)).toBeVisible({ timeout: 10_000 });
    const urlAfter = await webhookCard.locator('.font-mono').first().textContent();
    expect(urlAfter).not.toBe(urlBefore);
    expect(urlAfter).toMatch(/^https?:\/\/.+:3001\/webhooks\/.+\/[0-9a-f]{32}$/);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/07-after-rotate.png`, fullPage: true });

    // ── Delete (ConfirmDialog) ────────────────────────────────────────────────
    await webhookCard.getByRole('button', { name: /^delete$/i }).click();
    const deleteDialog = page.getByRole('dialog');
    await expect(deleteDialog).toBeVisible({ timeout: 5_000 });
    await expect(deleteDialog.getByText(/delete webhook/i)).toBeVisible();
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/08-delete-confirm-dialog.png`,
      fullPage: true,
    });
    await deleteDialog.getByRole('button', { name: /^delete$/i }).click();

    await expect(page.getByText(/webhook deleted/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: WEBHOOK_NAME })).not.toBeVisible({
      timeout: 5_000,
    });

    // ── Empty state (only asserted if the section was empty before this test) ──
    if (initiallyEmpty) {
      await expect(page.getByText(/no webhooks yet/i)).toBeVisible({ timeout: 5_000 });
    }
    await page.screenshot({ path: `${SCREENSHOT_DIR}/09-after-delete.png`, fullPage: true });
  });
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Best-effort: delete a webhook by name via the UI. Does not throw if absent. */
async function deleteWebhookIfPresent(page: Page, name: string): Promise<void> {
  try {
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    const card = page.locator('.rounded-xl').filter({ has: page.getByRole('heading', { name }) });
    if (!(await card.isVisible().catch(() => false))) return;

    await card.getByRole('button', { name: /^delete$/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
    await dialog.getByRole('button', { name: /^delete$/i }).click();
    await expect(page.getByText(/webhook deleted/i)).toBeVisible({ timeout: 10_000 });
  } catch {
    // Best-effort — cleanup failure must not fail the test.
  }
}
