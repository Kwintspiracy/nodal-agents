import { test, expect } from '@playwright/test';
import { requireLiveStack, testSlugSuffix } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('login + dashboard navigation', () => {
  test('local-trust install lands on /agents without a login form', async ({ page }) => {
    await page.goto('/');
    // Either we land directly on /agents (local-trust) or we hit /login
    // (local-auth). Both are valid post-redirect states; we assert the
    // local-trust path since the default install runs in trust mode.
    await page.waitForURL(/\/(agents|login|onboarding)$/, { timeout: 10_000 });
    if (page.url().includes('/login')) {
      test.skip(true, 'local-auth mode active — switch to local-trust for this smoke');
    }
    await expect(page.getByRole('heading', { name: /agents/i })).toBeVisible();
  });

  test('sidebar links every dashboard section', async ({ page }) => {
    await page.goto('/agents');
    if (page.url().includes('/login')) {
      test.skip(true, 'local-auth mode active');
    }

    for (const label of [
      'Tasks',
      'Jobs',
      'Memories',
      'Connectors',
      'Skills',
      'Approvals',
      'Settings',
      'Billing',
      'Logs',
      'Automations',
      'Stats',
    ]) {
      // Sidebar uses anchor tags. The accessible-name match is loose so
      // icons-with-labels and bare text both work.
      await expect(page.getByRole('link', { name: new RegExp(label, 'i') })).toBeVisible();
    }
  });
});

test.describe('agent → task → job flow', () => {
  test('creates an agent, sends a task, and shows the job in the list', async ({
    page,
  }) => {
    await page.goto('/agents');
    if (page.url().includes('/login')) {
      test.skip(true, 'local-auth mode active');
    }

    const slug = testSlugSuffix();
    const agentName = `E2E Agent ${slug}`;

    // ── Create agent ──────────────────────────────────────────────────────
    await page.getByRole('button', { name: /new agent/i }).click();
    await page.getByLabel(/^slug$/i).fill(slug);
    await page.getByLabel(/^name$/i).fill(agentName);
    await page.getByLabel(/personality/i).fill('You are helpful.');
    // Model select: pick the first available option (configured by CLI).
    const modelSelect = page.getByLabel(/^model$/i);
    if (await modelSelect.isVisible()) {
      const options = await modelSelect.locator('option').all();
      if (options.length > 0) {
        const value = await options[0]!.getAttribute('value');
        if (value) await modelSelect.selectOption(value);
      }
    }
    await page.getByRole('button', { name: /create agent/i }).click();

    // Wait for the agent name to appear in the table.
    await expect(page.getByText(agentName)).toBeVisible({ timeout: 10_000 });

    // ── Send task ─────────────────────────────────────────────────────────
    await page.goto('/tasks');
    const title = `E2E task ${slug}`;
    await page.getByLabel(/title|task/i).first().fill(title);
    // Agent picker — pick our just-created agent by name.
    const agentSelect = page.getByLabel(/agent/i);
    if (await agentSelect.isVisible()) {
      await agentSelect.selectOption({ label: agentName });
    }
    await page.getByRole('button', { name: /send|submit|create/i }).click();

    // ── Verify job exists ─────────────────────────────────────────────────
    await page.goto('/jobs');
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('settings pages render without runtime errors', () => {
  test('every (dashboard) route returns 200 and renders an h1', async ({ page }) => {
    const routes = [
      '/agents',
      '/tasks',
      '/jobs',
      '/memories',
      '/connectors',
      '/skills',
      '/approvals',
      '/settings',
      '/billing',
      '/logs',
      '/automations',
      '/stats',
    ];

    for (const r of routes) {
      const response = await page.goto(r);
      if (page.url().includes('/login')) {
        test.skip(true, 'local-auth mode active');
        return;
      }
      expect(response?.status(), `${r} HTTP status`).toBeLessThan(400);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 5_000 });
    }
  });
});
