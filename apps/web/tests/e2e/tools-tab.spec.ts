/**
 * Playwright e2e — Tools tab on the agent editor (added 17/07).
 *
 * `office-editing` and `command-execution` are "tool group" system skills
 * (see apps/web/src/lib/skill-tool-groups.ts: systemKind non-null AND
 * requiredBuiltins.length > 0) — they no longer appear as skills anywhere;
 * instead they surface as toggleable tool-group cards on the agent editor's
 * TOOLS tab. This spec validates that surface directly. The Command
 * execution → Autonomy tab Yolo-gate flow (enable via Tools tab → Yolo
 * section appears → ConfirmDialog → persistence) lives in the sibling spec
 * `command-execution-yolo.spec.ts`.
 *
 * Flow:
 *   Step 1 — Find an existing agent (skip suite if none).
 *   Step 2 — Tools tab lists both native tool groups (office-editing, command-execution).
 *   Step 3 — Disclosure "N tools" expands to chips of the gated builtin names
 *            (singular "1 tool" for command-execution, plural "24 tools" for office-editing).
 *   Step 4 — "Includes guidance" badge opens a read-only, dismissable modal with the
 *            skill's full content.
 *   Step 5 — Neither tool group appears on the agent's own Skills tab.
 *   Step 6 — Even once assigned to this agent, neither tool group appears in
 *            /skills → Assigned (the exclusion holds despite assignmentCount > 0).
 *
 * Requires a running Nodal-Agents stack (port 3000). Skipped automatically if not reachable.
 */

import { test, expect, type Page } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.describe.configure({ timeout: 60_000 });

/** Populated by Step 1 — the href of the first agent edit page found. */
let agentEditUrl: string | null = null;

/**
 * Navigate to the agent edit page and click the tab whose label starts with
 * `label`. The TabsBar (`@/components/ui/Tabs`) renders each tab as a
 * `<div role="tab">` inside a `role="tablist"` (not a `<button>`) — the
 * label may be immediately followed by a mono count with no space (e.g.
 * "Skills1"), hence the prefix match instead of an exact one.
 */
async function goToTab(page: Page, editUrl: string, label: string) {
  await page.goto(editUrl);
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  await page
    .getByRole('tab', { name: new RegExp(`^${label}`, 'i') })
    .first()
    .click();
  await page.waitForTimeout(600);
}

test.beforeAll(async () => {
  await requireLiveStack();
});

// ─── Step 1: Find an existing agent ──────────────────────────────────────────

test('Step 1 — find an existing agent (skip suite if none)', async ({ page }) => {
  await page.goto('/agents');
  await page.waitForLoadState('networkidle', { timeout: 15_000 });

  const editLinks = page.locator('a[href*="/agents/"][href$="/edit"]');
  const count = await editLinks.count();

  if (count === 0) {
    test.skip(true, 'No agents found — Tools tab tests skipped');
    return;
  }

  agentEditUrl = await editLinks.first().getAttribute('href');
  expect(agentEditUrl).toBeTruthy();
  console.log(`[Step 1] Using agent: ${agentEditUrl}`);
});

// ─── Step 2: Tools tab lists both native tool groups ─────────────────────────

test('Step 2 — Tools tab lists both native tool groups', async ({ page }) => {
  if (!agentEditUrl) {
    test.skip(true, 'No agent edit URL (Step 1 did not find an agent)');
    return;
  }

  await goToTab(page, agentEditUrl, 'Tools');

  const officeCard = page.locator('[data-testid="tool-group-card-office-editing"]');
  const cmdCard = page.locator('[data-testid="tool-group-card-command-execution"]');
  await expect(officeCard).toBeVisible({ timeout: 8_000 });
  await expect(cmdCard).toBeVisible({ timeout: 8_000 });
  await expect(officeCard.getByText('Office editing', { exact: true })).toBeVisible();
  await expect(cmdCard.getByText('Command execution', { exact: true })).toBeVisible();

  console.log('[Step 2] PASS — both tool-group cards render on the Tools tab');
});

// ─── Step 3: Disclosure expands to gated tool chips ──────────────────────────

test('Step 3 — disclosure expands to show the gated tool names as chips', async ({ page }) => {
  if (!agentEditUrl) {
    test.skip(true, 'No agent edit URL');
    return;
  }

  await goToTab(page, agentEditUrl, 'Tools');

  // command-execution gates exactly 1 builtin — exercises the singular "1 tool" label.
  const cmdCard = page.locator('[data-testid="tool-group-card-command-execution"]');
  const cmdDisclosure = cmdCard.getByText(/^1 tool$/);
  await expect(cmdDisclosure).toBeVisible({ timeout: 8_000 });
  await cmdDisclosure.click();
  await expect(cmdCard.locator('code', { hasText: 'run_command' })).toBeVisible({
    timeout: 4_000,
  });

  // office-editing gates 24 builtins — exercises the plural label + a real count.
  const officeCard = page.locator('[data-testid="tool-group-card-office-editing"]');
  const officeDisclosure = officeCard.getByText(/^24 tools$/);
  await expect(officeDisclosure).toBeVisible({ timeout: 8_000 });
  await officeDisclosure.click();
  await expect(officeCard.locator('code', { hasText: 'xlsx_read' })).toBeVisible({
    timeout: 4_000,
  });
  await expect(officeCard.locator('code', { hasText: 'pptx_replace_text' })).toBeVisible();

  const chipCount = await officeCard.locator('code').count();
  expect(chipCount).toBe(24);

  console.log('[Step 3] PASS — disclosures expand to the correct chip counts (1 / 24)');
});

// ─── Step 4: Guidance badge opens read-only modal ────────────────────────────

test('Step 4 — "Includes guidance" badge opens a read-only modal with the skill content', async ({
  page,
}) => {
  if (!agentEditUrl) {
    test.skip(true, 'No agent edit URL');
    return;
  }

  await goToTab(page, agentEditUrl, 'Tools');

  const cmdCard = page.locator('[data-testid="tool-group-card-command-execution"]');
  await cmdCard.getByRole('button', { name: /includes guidance/i }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 6_000 });
  await expect(dialog.locator('h3')).toHaveText('Command execution');
  await expect(dialog.getByText(/this skill unlocks the/i)).toBeVisible({ timeout: 4_000 });

  // Read-only + dismissable (default Modal behaviour) — closes via the corner
  // ✕ button, no Save/Cancel ModalFooter (nothing to edit here).
  await dialog.getByRole('button', { name: /close/i }).click();
  await expect(dialog).not.toBeVisible({ timeout: 4_000 });

  console.log('[Step 4] PASS — guidance modal shows the skill content and is dismissable');
});

// ─── Step 5: Absent from the agent's own Skills tab ──────────────────────────

test("Step 5 — office-editing and command-execution are absent from the agent's Skills tab", async ({
  page,
}) => {
  if (!agentEditUrl) {
    test.skip(true, 'No agent edit URL');
    return;
  }

  await goToTab(page, agentEditUrl, 'Skills');

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('Office editing');
  expect(bodyText).not.toContain('Command execution');

  console.log('[Step 5] PASS — neither tool group appears on the agent Skills tab');
});

// ─── Step 6: Absent from /skills Assigned even when assigned ────────────────

test('Step 6 — command-execution assigned to this agent is still absent from /skills Assigned', async ({
  page,
}) => {
  if (!agentEditUrl) {
    test.skip(true, 'No agent edit URL');
    return;
  }

  // Ensure it's actually assigned somewhere so the exclusion below is a real
  // test, not a vacuous pass — turn the Tools toggle ON for our agent if off.
  await goToTab(page, agentEditUrl, 'Tools');
  const toolSwitch = page.getByRole('switch', { name: /toggle command execution/i });
  await toolSwitch.waitFor({ state: 'visible', timeout: 8_000 });
  if ((await toolSwitch.getAttribute('aria-checked')) !== 'true') {
    await toolSwitch.click();
    await page
      .locator('[data-sonner-toast]')
      .filter({ hasText: /command execution enabled/i })
      .waitFor({ state: 'visible', timeout: 8_000 })
      .catch(() => {});
    await expect(toolSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 5_000 });
  }

  await page.goto('/skills');
  await page.waitForLoadState('networkidle', { timeout: 15_000 });

  const assignedTab = page.getByRole('tab', { name: /^assigned/i });
  if (await assignedTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await assignedTab.click();
    await page.waitForTimeout(400);
  }

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('Office editing');
  expect(bodyText).not.toContain('Command execution');

  console.log(
    '[Step 6] PASS — command-execution is assigned (assignmentCount > 0) yet absent from /skills Assigned',
  );
});
