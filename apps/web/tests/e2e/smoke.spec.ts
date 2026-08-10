/**
 * Playwright e2e — the boot journey: the dashboard opens, every section is
 * reachable, and an agent can be created and given a task.
 *
 * Realigned 2026-08-10. This spec had drifted behind two UI passes and was
 * asserting a product that no longer exists:
 *   - `/billing` — deleted in b29bdf2 (the 0.6.3 design pass)
 *   - `/stats`   — folded into the root page in 9c43de6 ("merge Home + Stats
 *                  into a single root page"), so `/` IS the dashboard and
 *                  redirects nowhere
 *   - sidebar labels 'Stats', 'Jobs', 'Memories', 'Billing' — now 'Home',
 *     'Runs', 'Memory', and gone, respectively
 *
 * The route list and the labels below are read from the real source of truth
 * (`components/Sidebar.tsx` NAV_ITEMS and the `(dashboard)` route folder). When
 * a section is added or renamed, this list is what must move with it.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, testSlugSuffix } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('dashboard navigation', () => {
  test('the root page IS the dashboard — no login form, no redirect away', async ({ page }) => {
    const response = await page.goto('/');

    // In local-trust the dashboard is open; in local-auth the session cookie
    // injected by global-setup carries us through. Either way the one thing
    // that must never happen is landing on the login form. Onboarding is a
    // legitimate destination on a stack with no LLM key configured yet.
    expect(page.url()).not.toMatch(/\/login/);
    expect(response?.status(), 'root page HTTP status').toBeLessThan(400);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });
  });

  test('sidebar links every dashboard section', async ({ page }) => {
    await page.goto('/agents');

    // Labels as rendered by Sidebar.tsx NAV_ITEMS (source of truth).
    for (const label of [
      'Home',
      'Chat',
      'Runs',
      'LLM Providers',
      'Agents',
      'Skills',
      'Learned Skills',
      'API Connectors',
      'MCP Connectors',
      'Credentials',
      'Memory',
      'Automations',
      'Approvals',
      'Logs',
      'Settings',
    ]) {
      // Sidebar uses anchor tags. The accessible-name match is loose so
      // icons-with-labels and bare text both work.
      await expect(
        page.getByRole('link', { name: new RegExp(label, 'i') }).first(),
        `sidebar link "${label}"`,
      ).toBeVisible();
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
    // The CTA is labelled "New task" (SendTaskForm.tsx), not "Send task" — and
    // the submit button inside the modal carries the SAME label, so the toolbar
    // click must happen while it is still the only one on the page.
    await page.getByRole('button', { name: /^new task$/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const title = `E2E task ${slug}`;
    // The textarea label is "Task description" (htmlFor="task-prompt").
    await dialog.getByLabel(/task description/i).fill(title);

    // Agent picker — label is "Assign to" (htmlFor="task-agent").
    // The option text is "{name} ({slug})", so match on our agent's name and
    // select by the value we find. The field is `required`: leaving it empty
    // silently blocks submission and the failure would surface much later, as a
    // navigation timeout, so assert we actually picked our agent.
    const agentSelect = dialog.getByLabel(/assign to/i);
    const options = await agentSelect.locator('option').all();
    let targetValue: string | null = null;
    for (const opt of options) {
      const text = await opt.innerText();
      if (text.includes(agentName)) {
        targetValue = await opt.getAttribute('value');
        break;
      }
    }
    expect(targetValue, `agent "${agentName}" missing from the Assign to picker`).toBeTruthy();
    await agentSelect.selectOption(targetValue!);

    // Submit — scoped to the dialog, since the toolbar CTA shares this label.
    await dialog.getByRole('button', { name: /^new task$/i }).click();

    // ── Verify job exists ─────────────────────────────────────────────────
    // sendTaskAction redirects to /jobs/<id> on success.
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/, { timeout: 15_000 });
    // The task text should appear somewhere on the job detail page.
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('settings pages render without runtime errors', () => {
  test('every (dashboard) route returns 200 and renders an h1', async ({ page }) => {
    // Every folder under src/app/(dashboard), plus the root page itself.
    const routes = [
      '/',
      '/agents',
      '/chat',
      '/jobs',
      '/memories',
      '/connectors',
      '/mcp',
      '/credentials',
      '/skills',
      '/learned-skills',
      '/llm-providers',
      '/approvals',
      '/settings',
      '/logs',
      '/automations',
    ];

    for (const r of routes) {
      const response = await page.goto(r);
      expect(response?.status(), `${r} HTTP status`).toBeLessThan(400);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 5_000 });
    }
  });
});
