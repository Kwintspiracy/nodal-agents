import { test, expect } from '@playwright/test';
import { requireLiveStack, testSlugSuffix } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('login + dashboard navigation', () => {
  test('authenticated session lands on the dashboard without a login form', async ({ page }) => {
    await page.goto('/');
    // Root page redirects → /stats (the Dashboard). The session cookie injected
    // by global-setup lets the proxy pass us through without hitting /login.
    await page.waitForURL(/\/(agents|onboarding|stats)(\?|$)/, { timeout: 10_000 });
    // Must not have landed on /login — global-setup ensures authentication.
    expect(page.url()).not.toMatch(/\/login/);
  });

  test('sidebar links every dashboard section', async ({ page }) => {
    await page.goto('/agents');

    // Labels as rendered by Sidebar.tsx NAV_ITEMS (source of truth).
    // Note: /jobs is labelled "Sessions" in the sidebar (not "Jobs").
    for (const label of [
      'Dashboard',
      'Agents',
      'Jobs',
      'Memories',
      'Connectors',
      'Skills',
      'Automations',
      'Approvals',
      'Logs',
      'Billing',
      'Settings',
    ]) {
      // Sidebar uses anchor tags. The accessible-name match is loose so
      // icons-with-labels and bare text both work.
      await expect(page.getByRole('link', { name: new RegExp(label, 'i') })).toBeVisible();
    }
  });
});

test.describe('agent → task → job flow', () => {
  test('creates an agent, sends a task, and shows the job in the list', async ({ page }) => {
    await page.goto('/agents');

    const slug = testSlugSuffix();
    const agentName = `E2E Agent ${slug}`;

    // ── Create agent ──────────────────────────────────────────────────────
    // AgentForm is hidden behind "+ New agent" button — click to open modal.
    await page.getByRole('button', { name: /new agent/i }).click();
    // Modal is rendered via createPortal — wait for it to appear in the DOM.
    const slugInput = page.locator('#agent-slug');
    await slugInput.waitFor({ state: 'visible', timeout: 5_000 });
    await slugInput.fill(slug);
    await page.locator('#agent-name').fill(agentName);
    await page.locator('#agent-personality').fill('You are helpful.');
    // Model select: pick the first available option (configured by CLI).
    const modelSelect = page.locator('#agent-model');
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
    // SendTaskForm lives on /jobs (creates an agent_jobs row, redirects to
    // /jobs/<id>). /tasks is reserved for the planner orchestrator's task board.
    await page.goto('/jobs');
    await page.getByRole('button', { name: /send task/i }).click();

    const title = `E2E task ${slug}`;
    // The textarea label is "Task description" (htmlFor="task-title").
    await page.getByLabel(/task description/i).fill(title);

    // Agent picker — label is "Assign to" (htmlFor="task-agent").
    // The option text is "{name} ({slug})" — select by partial label match using value-based approach.
    const agentSelect = page.getByLabel(/assign to/i);
    if (await agentSelect.isVisible()) {
      // Find the option whose text contains our agent name (partial match).
      const options = await agentSelect.locator('option').all();
      let targetValue: string | null = null;
      for (const opt of options) {
        const text = await opt.innerText();
        if (text.includes(agentName)) {
          targetValue = await opt.getAttribute('value');
          break;
        }
      }
      if (targetValue) {
        await agentSelect.selectOption(targetValue);
      }
    }
    await page.getByRole('button', { name: /^send task$/i }).click();

    // ── Verify job exists ─────────────────────────────────────────────────
    // sendTaskAction redirects to /jobs/<id> on success.
    await page.waitForURL(/\/jobs\//, { timeout: 15_000 });
    // The task text should appear somewhere on the job detail page.
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('settings pages render without runtime errors', () => {
  test('every (dashboard) route returns 200 and renders an h1', async ({ page }) => {
    const routes = [
      '/agents',
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
      expect(response?.status(), `${r} HTTP status`).toBeLessThan(400);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 5_000 });
    }
  });
});
