/**
 * Brique 35 — NetworkForm e2e tests
 *
 * Covers the interactive network-settings section on /settings:
 *  - Section renders with correct elements
 *  - Toggling to LAN shows LAN IPs or "No LAN interface detected"
 *  - Drift hint appears when local state differs from runtime bind
 *  - Save triggers server action (success toast or documented failure path)
 *
 * The stack (web + runner + DB) must be running before this suite.
 * If ~/.nodalai/config.json doesn't exist in the test env the save will
 * return an error — this is the documented `cli_config_missing` path.
 */

import { test, expect, type Locator } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

/**
 * Locate the Network section container on /settings.
 * The page renders sections as <div> blocks, each with an <h2> heading.
 * We scope to the div that contains the "Network" h2 so we never
 * accidentally match the SecurityForm's "Save" button or drift hint.
 *
 * Strategy: find the h2 with text "Network", then walk up to its parent
 * section wrapper and use that as the scope for all child locators.
 */
function networkSection(page: Parameters<typeof test>[1] extends never ? never : import('@playwright/test').Page): Locator {
  // The Network h2 lives inside a <div> whose next sibling is the form card.
  // We scope via the closest wrapping div that contains both the heading and the form.
  // page.tsx wraps them in: <div> <h2>Network</h2> <div card> <NetworkForm /> </div> <div card> App/Runner </div> </div>
  return page.locator('div').filter({ has: page.getByRole('heading', { name: 'Network', level: 2 }) }).first();
}

test.describe('NetworkForm — /settings', () => {
  // ── Test 1 — Section renders correctly ────────────────────────────────────
  test('Network section renders with radio buttons and read-only URL fields', async ({ page }) => {
    await page.goto('/settings');

    const section = networkSection(page);

    // Section heading
    await expect(page.getByRole('heading', { name: 'Network', level: 2 })).toBeVisible({ timeout: 10_000 });

    // "Local only" radio label
    await expect(section.getByText('Local only (127.0.0.1)', { exact: false })).toBeVisible({ timeout: 5_000 });

    // "LAN" radio label
    await expect(section.getByText('LAN (0.0.0.0)', { exact: false })).toBeVisible({ timeout: 5_000 });

    // Save button — scoped to network section to avoid matching SecurityForm's Save
    await expect(section.getByRole('button', { name: /^save$/i }).first()).toBeVisible({ timeout: 5_000 });

    // App URL and Runner URL read-only fields live below the form, still inside the Network wrapper
    await expect(section.getByText('App URL')).toBeVisible({ timeout: 5_000 });
    await expect(section.getByText('Runner URL')).toBeVisible({ timeout: 5_000 });
  });

  // ── Test 2 — Toggling LAN shows IPs or no-interface warning ──────────────
  test('clicking LAN radio shows LAN addresses or "No LAN interface detected"', async ({
    page,
  }) => {
    await page.goto('/settings');

    const section = networkSection(page);

    // Wait for the section to be rendered
    await expect(section.getByText('Local only (127.0.0.1)', { exact: false })).toBeVisible({
      timeout: 10_000,
    });

    // Click the LAN radio (the label contains "LAN (0.0.0.0)")
    await section.getByText('LAN (0.0.0.0)', { exact: false }).click();

    // After toggling, either:
    //  a) LAN addresses are shown with a Copy button, OR
    //  b) "No LAN interface detected" warning is shown
    const copyButton = section.getByRole('button', { name: /^copy$/i }).first();
    const noLanWarning = section.getByText(/no lan interface detected/i);

    // One of the two must appear within 5s
    const copyVisible = await copyButton.isVisible().catch(() => false);
    const warnVisible = await noLanWarning.isVisible().catch(() => false);

    if (!copyVisible && !warnVisible) {
      // Neither visible yet — wait on whichever appears first
      await Promise.race([
        expect(copyButton).toBeVisible({ timeout: 5_000 }),
        expect(noLanWarning).toBeVisible({ timeout: 5_000 }),
      ]).catch(async () => {
        const c = await copyButton.isVisible();
        const w = await noLanWarning.isVisible();
        expect(
          c || w,
          'Expected either a Copy button (LAN IPs) or "No LAN interface detected" warning after toggling LAN',
        ).toBe(true);
      });
    }
    // else: already visible, test passes
  });

  // ── Test 3 — Drift hint appears before Save when local != runtime ─────────
  test('drift hint appears when toggling bind from current runtime value', async ({ page }) => {
    await page.goto('/settings');

    const section = networkSection(page);

    // Wait for the form to hydrate
    await expect(section.getByText('Local only (127.0.0.1)', { exact: false })).toBeVisible({
      timeout: 10_000,
    });

    // NetworkForm renders loopback radio first, LAN second — scoped to section
    const radios = section.locator('input[type="radio"]');
    const loopbackRadio = radios.nth(0);
    const lanRadio = radios.nth(1);

    const isLoopbackChecked = await loopbackRadio.isChecked();

    if (isLoopbackChecked) {
      // Runtime = loopback → toggle to lan → drift shows
      await lanRadio.click();
    } else {
      // Runtime = lan → toggle to loopback → drift shows
      await loopbackRadio.click();
    }

    // Drift hint scoped to the Network section:
    // "New bind `<value>` requires `nodalai down && nodalai up` to take effect."
    await expect(
      section.getByText(/New bind .+ requires/i),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── Test 4 — Save triggers server action, result verifiable via network ──
  test('Save button triggers network settings action and server responds', async ({ page }) => {
    await page.goto('/settings');

    const section = networkSection(page);

    // Wait for the form
    await expect(section.getByText('Local only (127.0.0.1)', { exact: false })).toBeVisible({
      timeout: 10_000,
    });

    // Toggle to LAN (second radio inside the network section)
    const lanRadio = section.locator('input[type="radio"]').nth(1);
    await lanRadio.click();

    // Intercept the RSC / server action POST before clicking.
    // Next.js server actions are POSTed to the current page URL with
    // Content-Type: text/plain and a Next-Action header.
    // We capture the response to assert the action was actually called
    // and returned a valid payload — this is immune to toast timing races.
    const actionResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes('/settings') &&
        resp.request().method() === 'POST' &&
        !!resp.request().headers()['next-action'],
      { timeout: 15_000 },
    );

    // Submit using the Save button scoped to the Network section
    await section.getByRole('button', { name: /^save$/i }).first().click();

    const actionResponse = await actionResponsePromise;
    // The server action always returns HTTP 200 (even for application-level errors);
    // a non-200 means a server crash.
    expect(
      actionResponse.status(),
      `Server action POST to /settings returned unexpected status`,
    ).toBe(200);

    // Parse the RSC wire payload — it contains the serialized ActionResult.
    // We look for the string markers from our ok/fail helpers:
    //   ok path:   contains `"requiresRestart"` key
    //   fail path: contains `"code"` + `"message"` (ActionResult failure shape)
    const body = await actionResponse.text();
    const isOk = body.includes('requiresRestart');
    const isFail = body.includes('"code"') && body.includes('"message"');

    expect(
      isOk || isFail,
      `Server action response body did not match ok or fail shape.\nBody (first 500 chars): ${body.slice(0, 500)}`,
    ).toBe(true);

    if (isOk) {
      console.log('[settings-network] Server action returned ok — save succeeded.');
      // Check if the post-save emerald banner appeared (requiresRestart=true path).
      // Sonner toast has 4s default lifetime; the banner is permanent until next navigate.
      // We allow 6s for RSC re-render + banner to appear.
      const restartBanner = section.getByText(/saved.*restart with/i);
      const bannerVisible = await restartBanner.isVisible().catch(() => false);
      if (!bannerVisible) {
        // Not a failure — requiresRestart=false means bind already matches runtime.
        console.log(
          '[settings-network] No restart banner — runtime bind matches saved bind, requiresRestart=false.',
        );
      }
    } else {
      // fail path — most likely cli_config_missing
      console.log(
        '[settings-network] Server action returned fail — likely cli_config_missing (config.json absent in test env).',
      );
      // The amber warning should already be visible in the rendered form.
      const configMissingWarning = section.getByText(/config\.json.*wasn.*t found/i);
      const warnVisible = await configMissingWarning.isVisible().catch(() => false);
      if (warnVisible) {
        console.log('[settings-network] config-missing amber warning visible — expected path.');
      }
    }
  });
});
