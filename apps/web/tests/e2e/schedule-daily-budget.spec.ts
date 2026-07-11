/**
 * schedule-daily-budget.spec.ts
 *
 * Event Triggers, Brique 3 (F1) — the "Daily budget ($)" field on the
 * ScheduleForm (apps/web/src/app/(dashboard)/automations/ScheduleForm.tsx).
 *
 * Validates:
 *   A — The field is present on the New schedule form with a default of 5.
 *   B — Creating a schedule with a custom budget persists it (asserted on the
 *       real agent_schedules row — not just the UI echoing it back).
 *   C — Editing the budget and saving updates the row.
 *
 * Conventions match automations-notify-runnow.spec.ts (requireLiveStack in
 * beforeAll, storageState from playwright.config.ts, best-effort cleanup).
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, makeDbClient } from './helpers.ts';

const SCHEDULE_NAME = 'DailyBudget Validation e2e';
const TASK_TEXT = 'watch for new rows';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 90_000 });

async function selectFirstAgent(page: import('@playwright/test').Page): Promise<boolean> {
  const agentSelect = page.locator('#schedule-agent');
  await expect(agentSelect).toBeVisible({ timeout: 5_000 });
  const agentOptions = await agentSelect.locator('option').all();
  for (const opt of agentOptions) {
    const v = await opt.getAttribute('value');
    if (v && v.trim() !== '') {
      await agentSelect.selectOption(v);
      return true;
    }
  }
  return false;
}

async function deleteScheduleIfPresent(
  page: import('@playwright/test').Page,
  name: string,
): Promise<void> {
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

test.describe('Daily budget field on ScheduleForm', () => {
  test('is present with a default of 5 on the New schedule form', async ({ page }) => {
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /new schedule/i }).click();
    await expect(page.getByRole('heading', { name: /new schedule/i })).toBeVisible({
      timeout: 5_000,
    });

    const budgetInput = page.locator('#schedule-daily-budget');
    await expect(budgetInput).toBeVisible({ timeout: 5_000 });
    await expect(budgetInput).toHaveValue('5');

    await page.screenshot({
      path: 'tests/e2e/.artifacts/schedule-daily-budget-form.png',
      fullPage: true,
    });

    await page.getByRole('button', { name: /cancel/i }).click();
  });

  test('persists a custom value on create, and an edit updates it', async ({ page }) => {
    await deleteScheduleIfPresent(page, SCHEDULE_NAME);

    await page.goto('/automations');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /new schedule/i }).click();
    await expect(page.getByRole('heading', { name: /new schedule/i })).toBeVisible({
      timeout: 5_000,
    });

    const hasAgent = await selectFirstAgent(page);
    if (!hasAgent) {
      test.skip(true, 'No agents available in the e2e entity — cannot test budget persistence');
      return;
    }

    await page.locator('#schedule-name').fill(SCHEDULE_NAME);
    await page.locator('#schedule-task').fill(TASK_TEXT);
    await page.locator('#schedule-daily-budget').fill('17.5');

    await page.getByRole('button', { name: /create schedule/i }).click();
    await expect(page.getByText(/schedule created/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: SCHEDULE_NAME })).toBeVisible({
      timeout: 15_000,
    });

    // Assert on the real DB row, not just the UI echoing the value back.
    const { agentSchedules, eq } = await import('@nodal-agents/db');
    const { db, close } = makeDbClient();
    try {
      const rows = await db
        .select({ dailyBudgetUsd: agentSchedules.dailyBudgetUsd })
        .from(agentSchedules)
        .where(eq(agentSchedules.name, SCHEDULE_NAME));
      expect(rows[0]?.dailyBudgetUsd).toBe(17.5);
    } finally {
      await close();
    }

    // ── Edit: change the budget and save ─────────────────────────────────────
    const scheduleCard = page.locator('.rounded-xl').filter({
      has: page.getByRole('heading', { name: SCHEDULE_NAME }),
    });
    await scheduleCard.getByRole('button', { name: /^edit$/i }).click();
    await expect(page.getByRole('heading', { name: /edit schedule/i })).toBeVisible({
      timeout: 5_000,
    });

    const editBudgetInput = page.locator('#schedule-daily-budget');
    await expect(editBudgetInput).toHaveValue('17.5');
    await editBudgetInput.fill('40');
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText(/schedule updated/i)).toBeVisible({ timeout: 10_000 });

    const { db: db2, close: close2 } = makeDbClient();
    try {
      const rows = await db2
        .select({ dailyBudgetUsd: agentSchedules.dailyBudgetUsd })
        .from(agentSchedules)
        .where(eq(agentSchedules.name, SCHEDULE_NAME));
      expect(rows[0]?.dailyBudgetUsd).toBe(40);
    } finally {
      await close2();
    }

    await deleteScheduleIfPresent(page, SCHEDULE_NAME);
  });
});
