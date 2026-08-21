/**
 * Brique 35 — NetworkForm e2e tests
 *
 * Covers the interactive network-settings section on /settings:
 *  - Section renders with correct elements
 *  - Toggling to LAN shows LAN IPs or "No LAN interface detected"
 *  - Re-saving the running mode reports no restart needed
 *  - Saving the other mode persists it, demands a restart, and is restored
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
 * Locate the Network section on /settings, so no locator below can reach
 * another form's Save button.
 */
function networkSection(
  page: Parameters<typeof test>[1] extends never ? never : import('@playwright/test').Page,
): Locator {
  // SetBlock renders each settings group as a real <section> carrying its own
  // <h2>. Scoping on `div` instead matched the outermost wrapper that merely
  // CONTAINS that heading — i.e. most of the page — so "the first Save button
  // in the section" was whatever form happened to come first in the document,
  // and this suite drove the wrong one. `section` is exact by construction.
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Network', level: 2 }) })
    .first();
}

test.describe('NetworkForm — /settings', () => {
  // ── Test 1 — Section renders correctly ────────────────────────────────────
  test('Network section renders with radio buttons and read-only URL fields', async ({ page }) => {
    await page.goto('/settings');

    const section = networkSection(page);

    // Section heading
    await expect(page.getByRole('heading', { name: 'Network', level: 2 })).toBeVisible({
      timeout: 10_000,
    });

    // "Local only" radio label
    await expect(section.getByText('Local only (127.0.0.1)', { exact: false })).toBeVisible({
      timeout: 5_000,
    });

    // "LAN" radio label
    await expect(section.getByText('LAN (0.0.0.0)', { exact: false })).toBeVisible({
      timeout: 5_000,
    });

    // Save button — scoped to network section to avoid matching SecurityForm's Save
    await expect(section.getByRole('button', { name: /^save$/i }).first()).toBeVisible({
      timeout: 5_000,
    });

    // App URL and Runner URL moved out of the Network block into their own
    // "URLs" section, so they are asserted where they now live rather than
    // dropped — the page still has to show both.
    const urls = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'URLs', level: 2 }) })
      .first();
    await expect(urls.getByText('App URL')).toBeVisible({ timeout: 5_000 });
    await expect(urls.getByText('Runner URL')).toBeVisible({ timeout: 5_000 });
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

  /**
   * Which mode is selected, read the way a screen reader reads it.
   *
   * `input[type="radio"]` stood here and matched NOTHING: the DS's OptionRadio
   * draws its own dot and exposes `role="radio"` + `aria-checked`, with no
   * native input in the tree. Both tests below had been timing out on that
   * selector ever since — invisible, because the suite was never replayed.
   */
  async function selectedBind(section: Locator): Promise<'loopback' | 'lan'> {
    const checked = await section.getByRole('radio').nth(0).getAttribute('aria-checked');
    return checked === 'true' ? 'loopback' : 'lan';
  }

  /**
   * Pick a mode, submit, and wait for the save to have been ACKNOWLEDGED.
   *
   * The assertions below deliberately read the rendered result rather than the
   * server-action wire payload. Two attempts at the payload both produced a
   * green-looking parse of the wrong thing: /settings also fires a version-check
   * action (the first capture asserted against `{"current":"0.8.1",…}`), and a
   * Next action reply carries the revalidated page tree in the SAME response as
   * the result, so "the body mentions requiresRestart" matches the re-render
   * too. What the user sees, plus what survives a reload, is both stronger and
   * unambiguous.
   */
  async function chooseAndSave(
    page: import('@playwright/test').Page,
    section: Locator,
    bind: 'loopback' | 'lan',
  ): Promise<void> {
    await section
      .getByRole('radio')
      .nth(bind === 'loopback' ? 0 : 1)
      .click();
    await section
      .getByRole('button', { name: /^save$/i })
      .first()
      .click();
    // The success toast is the acknowledgement; a failure (cli_config_missing)
    // raises an error toast instead and this wait fails loudly on it.
    await expect(page.getByText(/network settings saved/i).first()).toBeVisible({
      timeout: 15_000,
    });
  }

  async function readySection(page: import('@playwright/test').Page): Promise<Locator> {
    const section = networkSection(page);
    await expect(section.getByRole('radio').first()).toBeVisible({ timeout: 10_000 });
    return section;
  }

  // ── Test 3 — Saving the mode already in force asks for no restart ─────────
  // The hint used to appear on TOGGLE, before saving, and this test asserted
  // that. It moved into the post-save banner, driven by the action's
  // `requiresRestart` — so the old assertion described a product that no longer
  // exists. This one re-saves the CURRENT mode, which mutates nothing and pins
  // the other half of the rule: same as the runtime → no restart demanded.
  test('re-saving the mode already in force reports no restart needed', async ({ page }) => {
    await page.goto('/settings');
    const section = await readySection(page);
    const current = await selectedBind(section);

    await chooseAndSave(page, section, current);

    // requiresRestart=false is what the absence of this banner means.
    await expect(section.getByText(/restart required/i)).toBeHidden();
    // And the mode is unchanged — this test must leave nothing behind.
    await page.reload();
    expect(await selectedBind(await readySection(page)), 'bind after reload').toBe(current);
  });

  // ── Test 4 — Saving the OTHER mode persists it and demands a restart ─────
  // This test used to click LAN, save, and then accept EITHER an ok or a fail
  // response — it could not go red. Worse, it wrote `lan` into the real
  // ~/.nodalai/config.json and never put it back: the next boot would have
  // bound the dashboard to 0.0.0.0 and switched the auth mode to local-auth,
  // i.e. a sign-in wall on a machine that had none. It only ever looked
  // harmless because the radio selector above was broken, so the save never
  // fired. Now it asserts the outcome, verifies the value survives a reload,
  // and restores what it found in a finally.
  test('saving the other mode persists it, demands a restart, and is put back', async ({
    page,
  }) => {
    await page.goto('/settings');
    let section = await readySection(page);
    const original = await selectedBind(section);
    const other = original === 'loopback' ? 'lan' : 'loopback';

    try {
      await chooseAndSave(page, section, other);
      // Different from the running bind, so the restart is mandatory: the
      // process is already bound to the old address and cannot rebind live.
      await expect(
        section.getByText(/restart required/i),
        'a bind that differs from the runtime must demand a restart',
      ).toBeVisible({ timeout: 10_000 });

      // Persisted, not just rendered: reload and read the value back.
      await page.reload();
      expect(await selectedBind(await readySection(page)), 'bind after reload').toBe(other);
    } finally {
      await page.goto('/settings');
      section = await readySection(page);
      if ((await selectedBind(section)) !== original) {
        await chooseAndSave(page, section, original);
        await page.reload();
        expect(
          await selectedBind(await readySection(page)),
          'FAILED TO RESTORE the original bind — check ~/.nodalai/config.json before the next boot',
        ).toBe(original);
      }
    }
  });
});
