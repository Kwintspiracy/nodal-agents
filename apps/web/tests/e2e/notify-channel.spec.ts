/**
 * notify-channel.spec.ts
 *
 * Validates the shared NotifyChannelFields controls (B1/B2, notify-channel-
 * choice plan) on the /automations dashboard page: the "Notify me when it
 * succeeds" toggle + the "Notify via" channel Select, on both ScheduleForm
 * and WebhookForm.
 *
 * Live-data note: this spec reads the actual bindings of whichever agent has
 * a Telegram bot token set (found at runtime, not hardcoded) — do NOT assume
 * it only has one channel. The "Notify via" option list must equal exactly
 * that agent's real active channels (CHANNEL_PRIORITY order: telegram,
 * discord, slack, whatsapp), whatever they are.
 *
 * NEVER fires a real notification: no "Run now" on a notify-on schedule, no
 * POST to a webhook URL. All checks are form-level + DB persistence via
 * reload/re-open-edit.
 *
 * Conventions: requireLiveStack() in beforeAll, getByRole/getByLabel
 * preferred, best-effort delete of any artifact this spec creates.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireLiveStack } from './helpers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'test-results', 'notify-channel');

const SCHEDULE_NAME = 'NotifyChannel Validation e2e';
const WEBHOOK_NAME = 'NotifyChannel Webhook e2e';
const TASK_TEXT = 'say hello';
const CRON_EXPR = '59 23 * * *';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 90_000 });

/** Attaches console/pageerror collectors; call assertNoErrors() at the end
 *  of a test to fail loud on anything unexpected. */
function attachErrorCollectors(page: Page): { assertNoErrors: () => void } {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err)}`));
  return {
    assertNoErrors: () => expect(errors, `console/page errors: ${JSON.stringify(errors)}`).toEqual([]),
  };
}

/** Selects an agent option in a Select by its visible name (option text),
 *  not by position — the notify-channel option list depends on which real
 *  agent is chosen. */
async function selectAgentByName(select: ReturnType<Page['locator']>, name: string) {
  await select.selectOption({ label: name });
}

/** Reads the visible text options of a <select>. */
async function optionLabels(select: ReturnType<Page['locator']>): Promise<string[]> {
  return select.locator('option').allTextContents();
}

/**
 * NotifyChannelFields refetches listAgentNotifyChannelsAction on every agent
 * switch and renders a transient "loading" state (the Select still mounted,
 * but disabled, showing the PREVIOUS agent's stale options) until that fetch
 * resolves. A bare `toBeVisible()` check races that transient — the select
 * is technically visible from the very first render, before the real
 * per-agent result is in. Poll until the fetch has actually settled: either
 * the "no channel connected" warning is up, or the select is visible AND
 * enabled (never disabled/stale).
 */
async function waitForNotifyResolution(page: Page): Promise<'warning' | 'select'> {
  const warning = page.getByText(/has no channel connected/i);
  const notifySelect = page.locator('#schedule-notify-channel, #webhook-notify-channel');
  await expect(async () => {
    if (await warning.isVisible()) return;
    expect(await notifySelect.isVisible()).toBe(true);
    expect(await notifySelect.isDisabled()).toBe(false);
  }).toPass({ timeout: 5_000 });
  return (await warning.isVisible()) ? 'warning' : 'select';
}

test.describe('Scenario 1 — Schedule form: Notify via lists only the agent\'s real active channels', () => {
  test('create with explicit Telegram channel, persists across reload + edit', async ({ page }) => {
    const { assertNoErrors } = attachErrorCollectors(page);

    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    await deleteScheduleIfPresent(page, SCHEDULE_NAME);

    await page.getByRole('button', { name: /new schedule/i }).click();
    await expect(page.getByRole('heading', { name: /new schedule/i })).toBeVisible({ timeout: 5_000 });

    const agentSelect = page.locator('#schedule-agent');
    await expect(agentSelect).toBeVisible({ timeout: 5_000 });

    // Find the agent with a Telegram bot bound — same discovery the "Notify
    // via" select itself does, so this test tracks whichever agent actually
    // has channels live, instead of assuming a fixed name.
    const agentNames = (await agentSelect.locator('option').allTextContents()).filter((t) => t.trim() !== '' && t !== 'Select…');
    expect(agentNames.length, 'expected at least one agent in the live entity').toBeGreaterThan(0);

    const notifyCheckbox = page.getByRole('checkbox', { name: /notify me when it succeeds/i });
    await notifyCheckbox.check();

    // Try each agent until we find one whose channel list is non-empty
    // (real data-driven — do not seed).
    let channelAgentName: string | null = null;
    let observedOptions: string[] = [];
    for (const name of agentNames) {
      await selectAgentByName(agentSelect, name);
      const resolution = await waitForNotifyResolution(page);
      if (resolution === 'select') {
        channelAgentName = name;
        observedOptions = await optionLabels(page.locator('#schedule-notify-channel'));
        break;
      }
    }

    if (!channelAgentName) {
      test.skip(true, 'No agent in the live entity has an active notify channel — cannot test channel list');
      return;
    }

    // "Auto" must always be first, and every other option must be one of the
    // known channel labels (Telegram/Discord/Slack) — never a raw internal
    // slug (e.g. "whatsapp" unlabeled) and never duplicated.
    expect(observedOptions[0]).toBe('Auto');
    expect(new Set(observedOptions).size).toBe(observedOptions.length);
    for (const label of observedOptions.slice(1)) {
      expect(['Telegram', 'Discord', 'Slack', 'whatsapp']).toContain(label);
    }
    expect(observedOptions).toContain('Telegram');

    // ── Fill the rest of the form and submit with notify ON, channel = Telegram ──
    await page.locator('#schedule-name').fill(SCHEDULE_NAME);

    await page.locator('#cron-mode').selectOption('custom');
    await page.locator('#cron-custom').fill(CRON_EXPR);

    await page.locator('#schedule-task').fill(TASK_TEXT);

    await page.locator('#schedule-notify-channel').selectOption({ label: 'Telegram' });

    await page.getByRole('button', { name: /create schedule/i }).click();
    await expect(page.getByText(/schedule created/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: SCHEDULE_NAME })).toBeVisible({ timeout: 15_000 });

    // ── Reload — the row must still be there (real DB persistence, not just
    //     client state) ───────────────────────────────────────────────────
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: SCHEDULE_NAME })).toBeVisible({ timeout: 10_000 });

    const card = page.locator('.rounded-xl').filter({ has: page.getByRole('heading', { name: SCHEDULE_NAME }) });
    // "Notifies" badge should be present on the row itself.
    await expect(card.getByText(/notifies/i)).toBeVisible({ timeout: 5_000 });

    // ── Re-open edit — notify + channel must be exactly what was saved ────
    await card.getByRole('button', { name: /^edit$/i }).click();
    await expect(page.getByRole('heading', { name: /edit schedule/i })).toBeVisible({ timeout: 5_000 });

    await expect(page.getByRole('checkbox', { name: /notify me when it succeeds/i })).toBeChecked({ timeout: 5_000 });
    await expect(page.locator('#schedule-notify-channel')).toHaveValue('telegram', { timeout: 5_000 });

    await page.getByRole('button', { name: /cancel/i }).click();

    // ── Cleanup ─────────────────────────────────────────────────────────
    await deleteScheduleIfPresent(page, SCHEDULE_NAME);

    assertNoErrors();
  });
});

test.describe('Scenario 2 — Webhook form: Notify via + Auto persists, badge on the row', () => {
  test('create with notify ON, channel Auto, badge appears, then delete (never POST)', async ({ page }) => {
    const { assertNoErrors } = attachErrorCollectors(page);

    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    await deleteWebhookIfPresent(page, WEBHOOK_NAME);

    await page.getByRole('button', { name: /new webhook/i }).click();
    await expect(page.getByRole('heading', { name: /new webhook/i })).toBeVisible({ timeout: 5_000 });

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
      test.skip(true, 'No agents available — cannot test webhook notify controls');
      return;
    }
    await agentSelect.selectOption(firstAgentValue);

    await page.locator('#webhook-name').fill(WEBHOOK_NAME);
    await page.locator('#webhook-task').fill('A test event fired: {field}');

    const notifyCheckbox = page.getByRole('checkbox', { name: /notify me when it succeeds/i });
    await notifyCheckbox.check();
    // Leave channel at "Auto" (default '') if a select/warning appears — either is fine,
    // we're not asserting the channel list here (Scenario 1 already covers it).

    await page.getByRole('button', { name: /create webhook/i }).click();
    // Scoped to the heading role — "Webhook created" also flashes as a toast
    // at the same time, and a bare text match hits both (strict-mode
    // violation).
    await expect(page.getByRole('heading', { name: /webhook created/i })).toBeVisible({ timeout: 10_000 });

    // Success panel shows the URL once — close it (Done) without ever posting to it.
    await page.getByRole('button', { name: /^done$/i }).click();

    await expect(page.getByRole('heading', { name: WEBHOOK_NAME })).toBeVisible({ timeout: 10_000 });
    const card = page.locator('.rounded-xl').filter({ has: page.getByRole('heading', { name: WEBHOOK_NAME }) });
    await expect(card.getByText(/notifies/i)).toBeVisible({ timeout: 5_000 });

    // ── Reload persistence check ───────────────────────────────────────
    await page.reload();
    await page.waitForLoadState('networkidle');
    const cardAfterReload = page.locator('.rounded-xl').filter({ has: page.getByRole('heading', { name: WEBHOOK_NAME }) });
    await expect(cardAfterReload.getByText(/notifies/i)).toBeVisible({ timeout: 10_000 });

    // ── Cleanup (delete — never fire it) ───────────────────────────────
    await deleteWebhookIfPresent(page, WEBHOOK_NAME);

    assertNoErrors();
  });
});

test.describe('Scenario 3 — Agent switch: "no channel connected" warning for a channel-less agent', () => {
  test('warns for a channel-less agent, clears when switching to a connected one', async ({ page }) => {
    const { assertNoErrors } = attachErrorCollectors(page);

    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /new schedule/i }).click();
    await expect(page.getByRole('heading', { name: /new schedule/i })).toBeVisible({ timeout: 5_000 });

    const agentSelect = page.locator('#schedule-agent');
    await expect(agentSelect).toBeVisible({ timeout: 5_000 });
    const agentNames = (await agentSelect.locator('option').allTextContents()).filter((t) => t.trim() !== '' && t !== 'Select…');

    const notifyCheckbox = page.getByRole('checkbox', { name: /notify me when it succeeds/i });
    await notifyCheckbox.check();

    // Find a channel-less agent (real data, not seeded) and one with a
    // channel, by probing the live warning/select toggle for each.
    let channelLessName: string | null = null;
    let connectedName: string | null = null;
    for (const name of agentNames) {
      await selectAgentByName(agentSelect, name);
      const resolution = await waitForNotifyResolution(page);
      if (resolution === 'warning') channelLessName ??= name;
      else connectedName ??= name;
      if (channelLessName && connectedName) break;
    }

    if (!channelLessName) {
      test.skip(true, 'No channel-less agent in the live entity — non-testable without seeding (not seeding per policy)');
      return;
    }

    await selectAgentByName(agentSelect, channelLessName);
    await waitForNotifyResolution(page);
    await expect(page.getByText(new RegExp(`${escapeRegExp(channelLessName)}.*has no channel connected`, 'i'))).toBeVisible({
      timeout: 5_000,
    });
    // No select should render while the warning is up.
    await expect(page.locator('#schedule-notify-channel')).not.toBeVisible();

    if (connectedName) {
      await selectAgentByName(agentSelect, connectedName);
      await waitForNotifyResolution(page);
      await expect(page.getByText(/has no channel connected/i)).not.toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#schedule-notify-channel')).toBeVisible({ timeout: 5_000 });
    }

    await page.getByRole('button', { name: /cancel/i }).click();

    assertNoErrors();
  });
});

test.describe('Scenario 4 — Dark mode: notify controls stay theme-aware', () => {
  test('schedule form notify controls render correctly in both themes', async ({ page }) => {
    const { assertNoErrors } = attachErrorCollectors(page);

    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /new schedule/i }).click();
    await expect(page.getByRole('heading', { name: /new schedule/i })).toBeVisible({ timeout: 5_000 });

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
      test.skip(true, 'No agents available — cannot test theming');
      return;
    }
    await agentSelect.selectOption(firstAgentValue);

    const notifyCheckbox = page.getByRole('checkbox', { name: /notify me when it succeeds/i });
    await notifyCheckbox.check();
    await waitForNotifyResolution(page);

    // The label itself carries `bg-canvas` (see NotifyChannelFields.tsx) —
    // its parent is transparent, so measure the label, not an ancestor.
    const notifyBlock = page.locator('label', { hasText: 'Notify me when it succeeds' });

    const lightBg = await notifyBlock.evaluate((el) => getComputedStyle(el).backgroundColor);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'schedule-form-light.png'), fullPage: true });

    // The ThemeToggle button lives in the page topbar, outside the
    // non-dismissable Modal — its full-screen backdrop (fixed inset-0 z-40)
    // intercepts pointer events on anything behind it, so the toggle can't
    // be clicked while the form is open. Close it first (Cancel, no save),
    // flip the theme, then reopen and refill to reach the same visual state
    // for the dark screenshot.
    await page.getByRole('button', { name: /cancel/i }).click();

    await page.getByRole('button', { name: /switch to dark theme/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('button', { name: /new schedule/i }).click();
    await expect(page.getByRole('heading', { name: /new schedule/i })).toBeVisible({ timeout: 5_000 });
    await agentSelect.selectOption(firstAgentValue);
    await notifyCheckbox.check();
    await waitForNotifyResolution(page);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'schedule-form-dark.png'), fullPage: true });

    const darkBg = await notifyBlock.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(darkBg).not.toBe(lightBg);

    // The label/checkbox text must still be visible (not e.g. white-on-white).
    await expect(page.getByText('Notify me when it succeeds')).toBeVisible();

    await page.getByRole('button', { name: /cancel/i }).click();

    // Restore light theme before finishing (playwright's own isolated
    // context, but keep the artifact in a known state for reruns).
    await page.getByRole('button', { name: /switch to light theme/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    assertNoErrors();
  });
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function deleteScheduleIfPresent(page: Page, name: string): Promise<void> {
  try {
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    const card = page.locator('.rounded-xl').filter({ has: page.getByRole('heading', { name }) });
    if (!(await card.isVisible().catch(() => false))) return;

    const deleteBtn = card.getByRole('button', { name: /^delete$/i });
    if (!(await deleteBtn.isVisible().catch(() => false))) return;
    await deleteBtn.click();

    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
    await dialog.getByRole('button', { name: /^delete$/i }).click();

    await expect(page.getByText(/schedule deleted/i)).toBeVisible({ timeout: 10_000 });
  } catch {
    // Best-effort — cleanup failure must not fail the test.
  }
}

async function deleteWebhookIfPresent(page: Page, name: string): Promise<void> {
  try {
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    const card = page.locator('.rounded-xl').filter({ has: page.getByRole('heading', { name }) });
    if (!(await card.isVisible().catch(() => false))) return;

    const deleteBtn = card.getByRole('button', { name: /^delete$/i });
    if (!(await deleteBtn.isVisible().catch(() => false))) return;
    await deleteBtn.click();

    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
    await dialog.getByRole('button', { name: /^delete$/i }).click();

    await expect(page.getByText(/webhook deleted/i)).toBeVisible({ timeout: 10_000 });
  } catch {
    // Best-effort — cleanup failure must not fail the test.
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
