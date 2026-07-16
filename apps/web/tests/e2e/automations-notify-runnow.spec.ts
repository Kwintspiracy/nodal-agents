/**
 * automations-notify-runnow.spec.ts
 *
 * Validates two features on the /automations dashboard page:
 *
 * A — Garde-fou warning: When "Notify me when it succeeds" is checked
 *     for a bot-less agent, a warning paragraph containing "has no channel connected"
 *     appears. When unchecked it disappears.
 *
 * B — Run now button: Creating a schedule with a task and clicking "▶ Run now"
 *     shows a success toast `Running "<name>" now`.
 *
 * C — Notify persistence: edit a schedule, check notify, save, re-open edit form,
 *     assert checkbox is still checked.
 *
 * Conventions:
 *  - requireLiveStack() in beforeAll — skip if stack unreachable.
 *  - storageState loaded by playwright.config.ts — no manual login.
 *  - Selectors: getByRole / getByLabel / getByText preferred.
 *  - Cleanup (best-effort): delete any schedule created by this spec at end.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

const SCHEDULE_NAME_B = 'RunNow Validation e2e';
const SCHEDULE_NAME_C = 'NotifyPersist Validation e2e';
const TASK_TEXT = 'say hello';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 90_000 });

// ─── Scenario A — Garde-fou warning ──────────────────────────────────────────

test.describe('Scenario A — Garde-fou: Telegram notify warning for bot-less agent', () => {
  test('shows warning when notify checked + bot-less agent; hides on uncheck', async ({ page }) => {
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    // Open the "+ New schedule" form.
    await page.getByRole('button', { name: /new schedule/i }).click();

    // Wait for the form to expand (the "New schedule" heading appears).
    await expect(page.getByRole('heading', { name: /new schedule/i })).toBeVisible({
      timeout: 5_000,
    });

    // Select an agent — pick the first available option in the Agent <select>.
    const agentSelect = page.locator('#schedule-agent');
    await expect(agentSelect).toBeVisible({ timeout: 5_000 });

    const agentOptions = await agentSelect.locator('option').all();
    // Find a non-empty option (skip the "Select…" placeholder value="").
    let firstAgentValue: string | null = null;
    for (const opt of agentOptions) {
      const v = await opt.getAttribute('value');
      if (v && v.trim() !== '') {
        firstAgentValue = v;
        break;
      }
    }

    if (!firstAgentValue) {
      // No agents available in the e2e entity — skip with a descriptive message.
      test.skip(true, 'No agents available in the e2e entity — cannot test garde-fou');
      return;
    }

    await agentSelect.selectOption(firstAgentValue);

    // The warning must NOT be visible yet (notify is unchecked by default).
    await expect(page.getByText(/has no channel connected/i)).not.toBeVisible();

    // Check the "Notify me when it succeeds" checkbox.
    const notifyCheckbox = page.getByRole('checkbox', { name: /notify me when it succeeds/i });
    await notifyCheckbox.check();

    // The warning is per-agent now (it appears only for an agent with ZERO
    // active channel bindings), and the bindings lookup is async — after an
    // agent switch the panel resolves to either the warning OR the "Notify
    // via" select. Iterate the real agents until one shows the warning; skip
    // if every agent has a channel (nothing to assert without seeding, and
    // seeding assertion data is banned).
    const warning = page.getByText(/has no channel connected/i);
    const notifyVia = page.getByLabel(/notify via/i);
    let channelLessFound = false;
    for (const opt of agentOptions) {
      const v = await opt.getAttribute('value');
      if (!v || v.trim() === '') continue;
      await agentSelect.selectOption(v);
      // Wait for the async bindings fetch to SETTLE. The "Notify via" select
      // stays mounted but DISABLED while the fetch is in flight, so mere
      // visibility is a transient state — the settled signals are: warning
      // visible, or the select visible AND enabled.
      await expect
        .poll(
          async () =>
            (await warning.isVisible()) ||
            ((await notifyVia.isVisible()) && (await notifyVia.isEnabled())),
          { timeout: 5_000 },
        )
        .toBe(true);
      if (await warning.isVisible()) {
        channelLessFound = true;
        break;
      }
    }
    if (!channelLessFound) {
      test.skip(true, 'Every agent has an active channel — garde-fou not observable on this data');
      return;
    }

    // Uncheck — warning should disappear.
    await notifyCheckbox.uncheck();
    await expect(warning).not.toBeVisible();

    // Close the form (Cancel button).
    await page.getByRole('button', { name: /cancel/i }).click();
  });
});

// ─── Scenario B — Run now button ──────────────────────────────────────────────

test.describe('Scenario B — Run now button shows success toast', () => {
  test('creates a schedule then clicks Run now and sees success toast', async ({ page }) => {
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    // ── Pre-cleanup: remove any leftover from a prior run ────────────────────
    await deleteScheduleIfPresent(page, SCHEDULE_NAME_B);

    // ── Open + fill the New schedule form ────────────────────────────────────
    await page.getByRole('button', { name: /new schedule/i }).click();
    await expect(page.getByRole('heading', { name: /new schedule/i })).toBeVisible({
      timeout: 5_000,
    });

    // Select first available agent.
    const agentSelect = page.locator('#schedule-agent');
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
      test.skip(true, 'No agents available — cannot test Run now');
      return;
    }
    await agentSelect.selectOption(firstAgentValue);

    // Fill schedule name.
    await page.locator('#schedule-name').fill(SCHEDULE_NAME_B);

    // Fill task instructions.
    await page.locator('#schedule-task').fill(TASK_TEXT);

    // Leave notify unchecked (default).

    // Submit.
    await page.getByRole('button', { name: /create schedule/i }).click();

    // Wait for success toast.
    await expect(page.getByText(/schedule created/i)).toBeVisible({ timeout: 10_000 });

    // Wait for the schedule card to appear in the list (page refreshes or re-renders).
    await expect(page.getByRole('heading', { name: SCHEDULE_NAME_B })).toBeVisible({
      timeout: 15_000,
    });

    // ── Click "▶ Run now" on that card ───────────────────────────────────────
    // Scope to the card that has the schedule name as heading.
    const scheduleCard = page.locator('.rounded-xl').filter({
      has: page.getByRole('heading', { name: SCHEDULE_NAME_B }),
    });
    await expect(scheduleCard).toBeVisible({ timeout: 5_000 });

    const runNowBtn = scheduleCard.getByRole('button', { name: /run now/i });
    await expect(runNowBtn).toBeVisible({ timeout: 5_000 });
    await expect(runNowBtn).toBeEnabled({ timeout: 5_000 });

    await runNowBtn.click();

    // Assert success toast: `Running "<name>" now`
    await expect(
      page.getByText(new RegExp(`Running.*${escapeRegExp(SCHEDULE_NAME_B)}.*now`, 'i')),
    ).toBeVisible({ timeout: 10_000 });

    // ── Cleanup ───────────────────────────────────────────────────────────────
    await deleteScheduleIfPresent(page, SCHEDULE_NAME_B);
  });
});

// ─── Scenario C — Notify persistence ─────────────────────────────────────────

test.describe('Scenario C — Notify persistence: checkbox survives edit + save', () => {
  test('creates schedule, edits to check notify, re-opens edit form, notify is still checked', async ({
    page,
  }) => {
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    // Pre-cleanup.
    await deleteScheduleIfPresent(page, SCHEDULE_NAME_C);

    // ── Create a schedule (notify unchecked) ─────────────────────────────────
    await page.getByRole('button', { name: /new schedule/i }).click();
    await expect(page.getByRole('heading', { name: /new schedule/i })).toBeVisible({
      timeout: 5_000,
    });

    const agentSelect = page.locator('#schedule-agent');
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
      test.skip(true, 'No agents available — cannot test notify persistence');
      return;
    }
    await agentSelect.selectOption(firstAgentValue);
    await page.locator('#schedule-name').fill(SCHEDULE_NAME_C);
    await page.locator('#schedule-task').fill(TASK_TEXT);

    // Submit with notify OFF.
    await page.getByRole('button', { name: /create schedule/i }).click();
    await expect(page.getByText(/schedule created/i)).toBeVisible({ timeout: 10_000 });

    // Wait for card.
    await expect(page.getByRole('heading', { name: SCHEDULE_NAME_C })).toBeVisible({
      timeout: 15_000,
    });

    // ── Edit: open edit form, enable notify, save ─────────────────────────────
    const scheduleCard = page.locator('.rounded-xl').filter({
      has: page.getByRole('heading', { name: SCHEDULE_NAME_C }),
    });

    const editBtn = scheduleCard.getByRole('button', { name: /^edit$/i });
    await editBtn.click();

    // The edit form should now be visible (heading "Edit schedule").
    await expect(page.getByRole('heading', { name: /edit schedule/i })).toBeVisible({
      timeout: 5_000,
    });

    // Check the notify checkbox.
    const notifyCheckbox = page.getByRole('checkbox', { name: /notify me when it succeeds/i });
    await expect(notifyCheckbox).toBeVisible({ timeout: 5_000 });
    await notifyCheckbox.check();

    // (No warning assertion here: whether one appears depends on the selected
    // agent's real channel bindings — scenario A owns that behavior. This
    // scenario only cares that the checkbox state survives the edit round-trip.)

    // Save.
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText(/schedule updated/i)).toBeVisible({ timeout: 10_000 });

    // ── Re-open edit form and assert notify is still checked ──────────────────
    const updatedCard = page.locator('.rounded-xl').filter({
      has: page.getByRole('heading', { name: SCHEDULE_NAME_C }),
    });
    const editBtn2 = updatedCard.getByRole('button', { name: /^edit$/i });
    await editBtn2.click();

    await expect(page.getByRole('heading', { name: /edit schedule/i })).toBeVisible({
      timeout: 5_000,
    });
    const notifyCheckboxAgain = page.getByRole('checkbox', { name: /notify me when it succeeds/i });
    await expect(notifyCheckboxAgain).toBeChecked({ timeout: 5_000 });

    // Cancel edit.
    await page.getByRole('button', { name: /cancel/i }).click();

    // ── Cleanup ───────────────────────────────────────────────────────────────
    await deleteScheduleIfPresent(page, SCHEDULE_NAME_C);
  });
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Attempt to delete a schedule by name via the UI.
 * Best-effort: does not throw if the schedule is absent.
 */
async function deleteScheduleIfPresent(
  page: import('@playwright/test').Page,
  name: string,
): Promise<void> {
  try {
    // Navigate fresh to get a clean state.
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    // Look for the card heading.
    const card = page.locator('.rounded-xl').filter({
      has: page.getByRole('heading', { name }),
    });

    if (!(await card.isVisible().catch(() => false))) return;

    const deleteBtn = card.getByRole('button', { name: /^delete$/i });
    if (!(await deleteBtn.isVisible().catch(() => false))) return;

    await deleteBtn.click();

    // ConfirmDialog pops up — confirm.
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
    await dialog.getByRole('button', { name: /^delete$/i }).click();

    await expect(page.getByText(/schedule deleted/i)).toBeVisible({ timeout: 10_000 });
  } catch {
    // Best-effort — cleanup failure must not fail the test.
  }
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
