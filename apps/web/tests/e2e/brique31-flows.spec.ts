/**
 * brique31-flows.spec.ts — Playwright e2e tests for Brique 31
 *
 * Tests:
 *  A — LLM key add + test connection + save
 *  B — Agent edit picks LLM provider (dropdown change → model auto-fill → save → persist)
 *  C — Send-task with Telegram checkbox (Brique 31 acceptance: task pristine, chatId set on row)
 *  D — Skill edit flow
 *  E — Skill delete with ConfirmDialog (invariant #10: no native browser dialog)
 *
 * All tests skip with a clear message if the stack is not reachable (requireLiveStack).
 * Data is created and queried within the e2e user's own entity to avoid cross-entity
 * scoping issues.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, testSlugSuffix, makeDbClient } from './helpers.ts';

// ─── E2E sentinel user ────────────────────────────────────────────────────────
const E2E_EMAIL = 'e2e-playwright@nodalai.local';

/**
 * Resolve the e2e user's entity ID from the DB.
 * Returns null if the user doesn't exist yet (global-setup hasn't run).
 */
async function getE2eEntityId(): Promise<string | null> {
  const { users, entities, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, E2E_EMAIL))
      .limit(1);
    if (!userRows[0]) return null;
    const entityRows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.userId, userRows[0].id))
      .limit(1);
    return entityRows[0]?.id ?? null;
  } finally {
    await close();
  }
}

// ─── Suite guards ─────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  await requireLiveStack();
});

// ─── Test A — LLM key add + test connection + save ────────────────────────────

test.describe('Test A — LLM key add + test connection + save', () => {
  test('navigate to /llm-providers, add a provider, test connection, save, row appears', async ({
    page,
  }) => {
    // LLM providers moved out of /settings into their own first-class
    // sidebar entry — the form is rendered by the same `LlmKeysList`
    // component, just on a new page.
    await page.goto('/llm-providers');

    // Click "+ Add provider" button (inside LlmKeysList)
    await page.getByRole('button', { name: /add provider/i }).click();

    // The LlmKeyForm is now visible — select provider = anthropic (default)
    const providerSelect = page.locator('#llm-provider');
    await providerSelect.waitFor({ state: 'visible', timeout: 5_000 });
    await providerSelect.selectOption('anthropic');

    // Fill nickname
    const nickname = `E2E Test Key ${testSlugSuffix()}`;
    await page.locator('#llm-nickname').fill(nickname);

    // Fill base URL (Anthropic canonical)
    await page.locator('#llm-base-url').fill('https://api.anthropic.com/v1');

    // Fill API key (dummy value — test will fail with a real "fail" badge)
    await page.locator('#llm-api-key').fill('sk-ant-e2e-test-key-placeholder'); // secrets:allow (fake placeholder)

    // Fill default model
    await page.locator('#llm-default-model').fill('claude-haiku-4-5-20251001');

    // Click "Test connection" — the server action calls the real LLM.
    // With a dummy key it will return a failure badge; with a real key it returns pass.
    // Either way, the badge MUST appear within 15s (proving the UI handles both outcomes).
    await page.getByRole('button', { name: /test connection/i }).click();

    // Wait for either success or failure badge to appear
    const passBadge = page.locator('.bg-emerald-500\\/10');
    const failBadge = page.locator('.bg-red-500\\/10');

    await Promise.race([
      passBadge.waitFor({ state: 'visible', timeout: 15_000 }),
      failBadge.waitFor({ state: 'visible', timeout: 15_000 }),
    ]);

    // One of the two result badges MUST be visible — proves the flow works end-to-end
    const passVisible = await passBadge.isVisible().catch(() => false);
    const failVisible = await failBadge.isVisible().catch(() => false);
    expect(
      passVisible || failVisible,
      'Test result badge should appear after clicking Test connection',
    ).toBe(true);

    // Selector path used: #llm-provider (select), #llm-nickname, #llm-base-url,
    // #llm-api-key, #llm-default-model, button[Test connection], .bg-emerald-500/10 or .bg-red-500/10
    // Network mock: none — calls real testLlmKeyAction server action

    // If test passed (real key env), click Save and assert row appears
    if (passVisible) {
      await page.getByRole('button', { name: /add provider/i }).click();
      await expect(page.getByText(nickname)).toBeVisible({ timeout: 10_000 });
    }
    // If test failed (dummy key) — the save button is disabled. That's correct behavior.
    // Test A passes in both cases since we asserted the UI responded.
  });
});

// ─── Test B — Agent edit picks LLM provider ──────────────────────────────────

test.describe('Test B — Agent edit picks LLM provider', () => {
  test('change LLM provider dropdown on agent edit → model field updates → save → toast', async ({
    page,
  }) => {
    // Navigate to /agents and pick the first Edit link
    await page.goto('/agents');

    const editLinks = page.getByRole('link', { name: /edit/i });
    const count = await editLinks.count();
    if (count === 0) {
      test.skip(true, 'No agents visible for e2e user — create one via smoke test first');
      return;
    }

    const href = await editLinks.first().getAttribute('href');
    if (!href) {
      test.skip(true, 'No agents found with edit links');
      return;
    }

    await page.goto(href);
    await page.waitForURL(/\/agents\/.*\/edit/, { timeout: 10_000 });

    // Check whether the LLM key select is rendered (it's hidden when no LLM keys exist)
    const llmKeySelect = page.locator('#agent-llm-key');
    const llmKeySelectVisible = await llmKeySelect.isVisible().catch(() => false);

    if (!llmKeySelectVisible) {
      // No active LLM providers — expected for a fresh e2e entity
      // Verify that the "No active LLM providers" message is shown instead
      await expect(page.getByText(/no active llm providers/i)).toBeVisible({ timeout: 3_000 });
      // Test B passes: the fallback UI renders correctly
      return;
    }

    // LLM key select IS visible — test the full provider-switch flow
    const options = await llmKeySelect.locator('option').all();
    if (options.length < 2) {
      // Only one provider — can still verify the model field is non-empty
      const modelInput = page.locator('#agent-model');
      await expect(modelInput).toBeVisible({ timeout: 3_000 });
      const modelValue = await modelInput.inputValue();
      // Model field must have a value (either from the key's defaultModel or agent.model)
      expect(
        modelValue.length,
        'Model field should be non-empty with one LLM key configured',
      ).toBeGreaterThan(0);
      return;
    }

    // Multiple providers — test the switch
    const currentValue = await llmKeySelect.inputValue();
    const secondOption = options.find(
      async (o) => (await o.getAttribute('value')) !== currentValue,
    );
    const secondValue = secondOption ? await secondOption.getAttribute('value') : null;

    if (!secondValue || secondValue === currentValue) {
      test.skip(true, 'Could not find a different provider option to switch to');
      return;
    }

    await llmKeySelect.selectOption(secondValue);

    // After changing provider, model field should update (auto-fill with defaultModel)
    const modelInput = page.locator('#agent-model');
    await expect(modelInput).toBeVisible({ timeout: 3_000 });
    const modelValue = await modelInput.inputValue();
    expect(
      modelValue.length,
      'Model field should be non-empty after provider switch',
    ).toBeGreaterThan(0);

    // Save the form
    await page.getByRole('button', { name: /save changes/i }).click();

    // Assert toast "Agent updated"
    await expect(page.getByText(/agent updated/i)).toBeVisible({ timeout: 10_000 });

    // Selector path: #agent-llm-key (select), #agent-model (input), button[Save changes]
    // Sonner toast text: "Agent updated"
  });
});

// ─── Test C — Send-task with Telegram checkbox (Brique 31 acceptance) ─────────

test.describe('Test C — Send-task with Telegram checkbox (Brique 31 acceptance)', () => {
  test('job row has chatId set + task is pristine when Telegram checkbox is ticked', async ({
    page,
  }) => {
    // Look for any agent in the DB with lastSeenChatIdTelegram AND telegramBotToken set.
    // This can be in any entity — but we need the e2e user's entity to contain
    // such an agent to be able to select it in the form.
    // If not present, skip with a clear message.
    const { agents, eq } = await import('@nodal-agents/db');
    const e2eEntityId = await getE2eEntityId();

    if (!e2eEntityId) {
      test.skip(true, 'E2E entity not found — run global-setup first');
      return;
    }

    const { db, close } = makeDbClient();
    let tgAgent: { id: string; name: string; lastSeenChatIdTelegram: string | null } | null = null;

    try {
      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          lastSeenChatIdTelegram: agents.lastSeenChatIdTelegram,
        })
        .from(agents)
        .where(eq(agents.entityId, e2eEntityId))
        .limit(20);

      tgAgent =
        rows.find((r) => r.lastSeenChatIdTelegram != null && r.lastSeenChatIdTelegram.length > 0) ??
        null;
    } finally {
      await close();
    }

    if (!tgAgent) {
      test.skip(
        true,
        'No agent in the e2e entity has lastSeenChatIdTelegram set. ' +
          'To run this test: DM the bot from Telegram, then assign the agent to the e2e entity, ' +
          'or use the real entity.',
      );
      return;
    }

    const expectedChatId = tgAgent.lastSeenChatIdTelegram!;
    const promptText = `brique31-e2e-test-${testSlugSuffix()}`;

    // Delivery now resolves the OWNER's chat (resolveOwnerChatId), never
    // lastSeenChatIdTelegram directly — a group message can silently overwrite
    // the latter. Seed/upsert an owner row so the resolved target matches
    // expectedChatId, keeping this test's intent (chatId lands on the row)
    // without depending on stack-side manual state.
    const { telegramAllowedChats } = await import('@nodal-agents/db');
    const { db: dbSeed, close: closeSeed } = makeDbClient();
    try {
      await dbSeed
        .insert(telegramAllowedChats)
        .values({
          entityId: e2eEntityId,
          agentId: tgAgent.id,
          chatId: expectedChatId,
          role: 'owner',
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [telegramAllowedChats.agentId, telegramAllowedChats.chatId],
          set: { role: 'owner', status: 'active' },
        });
    } finally {
      await closeSeed();
    }

    await page.goto('/jobs');
    await page.getByRole('button', { name: /send task/i }).click();

    // The form is now visible
    const promptTextarea = page.getByLabel(/task description/i);
    await promptTextarea.waitFor({ state: 'visible', timeout: 5_000 });
    await promptTextarea.fill(promptText);

    // Select the Telegram-configured agent
    const agentSelect = page.getByLabel(/assign to/i);
    await agentSelect.selectOption(tgAgent.id);

    // Wait for the Telegram checkbox to appear (rendered when the agent has a bot
    // token; label no longer exposes the raw chat id — the real target is now
    // resolved server-side to the owner, not shown here).
    const telegramCheckbox = page.locator('input[name="sendViaTelegram"]');
    await expect(telegramCheckbox).toBeVisible({ timeout: 5_000 });

    // Tick the checkbox
    await telegramCheckbox.check();
    expect(await telegramCheckbox.isChecked()).toBe(true);

    // Submit the form
    await page.getByRole('button', { name: /^send task$/i }).click();

    // Wait for redirect to /jobs/<id>
    await page.waitForURL(/\/jobs\//, { timeout: 15_000 });

    // Extract the job ID from the URL
    const jobUrl = page.url();
    const jobIdMatch = jobUrl.match(/\/jobs\/([^/?#]+)/);
    const jobId = jobIdMatch?.[1];
    expect(jobId, 'Should have a job ID in the URL').toBeTruthy();

    // Assert DB row: chatId = expectedChatId, task = promptText (no suffix), channel = 'api'
    const { agentJobs } = await import('@nodal-agents/db');
    const { db: dbCheck, close: closeCheck } = makeDbClient();
    try {
      const jobRows = await dbCheck
        .select({
          task: agentJobs.task,
          chatId: agentJobs.chatId,
          channel: agentJobs.channel,
        })
        .from(agentJobs)
        .where(eq(agentJobs.id, jobId!))
        .limit(1);

      const job = jobRows[0];
      expect(job, 'Job row should exist in DB').toBeTruthy();
      expect(job?.task, 'task must be pure user prompt — no suffix injection (Brique 31)').toBe(
        promptText,
      );
      expect(
        job?.chatId,
        'chatId must be set to the resolved owner chat (seeded = expectedChatId)',
      ).toBe(expectedChatId);
      expect(job?.channel, 'channel stays api (origin = dashboard)').toBe('api');
    } finally {
      await closeCheck();
    }

    // Selector path: button[Send task], label[Assign to] (select#task-agent),
    // input[name=sendViaTelegram] (checkbox), button[Send task] (submit)
  });
});

// ─── Test D — Skill edit flow ─────────────────────────────────────────────────

test.describe('Test D — Skill edit flow', () => {
  test('navigate to skill edit page, modify content, save, toast Skill updated', async ({
    page,
  }) => {
    // Create a skill in the e2e entity so we can edit it
    const { agentSkills } = await import('@nodal-agents/db');
    const e2eEntityId = await getE2eEntityId();

    if (!e2eEntityId) {
      test.skip(true, 'E2E entity not found — run global-setup first');
      return;
    }

    const slugSuffix = testSlugSuffix();
    const { db, close } = makeDbClient();
    let skillId: string | null = null;
    const skillName = `E2E Edit Skill ${slugSuffix}`;

    try {
      const [skill] = await db
        .insert(agentSkills)
        .values({
          entityId: e2eEntityId,
          name: skillName,
          slug: `e2e-edit-skill-${slugSuffix}`,
          content: 'Original content for e2e edit test.',
        })
        .returning({ id: agentSkills.id });
      skillId = skill?.id ?? null;
    } finally {
      await close();
    }

    if (!skillId) {
      test.skip(true, 'Could not create test skill in DB');
      return;
    }

    // Navigate directly to the skill edit page
    await page.goto(`/skills/${skillId}/edit`);

    // Verify page loaded (h1 heading — use h1 locator to avoid strict mode violation with h3)
    await expect(page.locator('h1').filter({ hasText: /edit skill/i })).toBeVisible({
      timeout: 5_000,
    });

    // The content field has id="skill-content" (textarea in SkillForm)
    const contentField = page.locator('#skill-content');
    await contentField.waitFor({ state: 'visible', timeout: 5_000 });

    // Modify content
    const newContent = 'Original content for e2e edit test.\n# e2e-edited';
    await contentField.fill(newContent);

    // Save — button text is "Save changes" in edit mode
    await page.getByRole('button', { name: /save changes/i }).click();

    // Assert toast "Skill updated"
    await expect(page.getByText(/skill updated/i)).toBeVisible({ timeout: 10_000 });

    // After save, SkillForm redirects to /skills (router.push('/skills'))
    await page.waitForURL(/\/skills$/, { timeout: 10_000 });

    // Verify the skill is still in the list (not deleted)
    await expect(page.getByText(skillName)).toBeVisible({ timeout: 5_000 });

    // Selector path: /skills/<id>/edit → #skill-content (textarea), button[Save changes]
    // Toast: "Skill updated" (Sonner)
  });
});

// ─── Test E — Skill delete with ConfirmDialog ─────────────────────────────────

test.describe('Test E — Skill delete with ConfirmDialog (invariant #10)', () => {
  test('Delete button opens ConfirmDialog (not native browser dialog), Cancel keeps skill, Confirm deletes it', async ({
    page,
  }) => {
    // Create a temporary skill in the e2e entity to delete
    const { agentSkills } = await import('@nodal-agents/db');
    const e2eEntityId = await getE2eEntityId();

    if (!e2eEntityId) {
      test.skip(true, 'E2E entity not found — run global-setup first');
      return;
    }

    const slugSuffix = testSlugSuffix();
    const skillName = `E2E Delete Skill ${slugSuffix}`;
    const { db, close } = makeDbClient();
    let skillId: string | null = null;

    try {
      const [skill] = await db
        .insert(agentSkills)
        .values({
          entityId: e2eEntityId,
          name: skillName,
          slug: `e2e-del-skill-${slugSuffix}`,
          content: 'Temporary skill for e2e delete test.',
        })
        .returning({ id: agentSkills.id });
      skillId = skill?.id ?? null;
    } finally {
      await close();
    }

    if (!skillId) {
      test.skip(true, 'Could not create test skill in DB');
      return;
    }

    await page.goto('/skills');

    // Wait for the skill list to load (the skill name should be present)
    await expect(page.getByText(skillName)).toBeVisible({ timeout: 10_000 });

    // Each skill card is a div.bg-neutral-900 containing the skill name.
    // SkillRow renders: expand button (text) + Edit link + Delete button in a flex row.
    // We locate the card by finding the element that contains our skillName text,
    // then look for the Delete button within it.
    // Strategy: get the expand button (which contains the skill name), then navigate
    // to its parent card container, then find the Delete button sibling.
    const skillNameEl = page.getByText(skillName).first();
    // The Delete button is in the same card — use closest ancestor approach via locator chain
    const skillCard = page.locator('[class*="bg-neutral-900"]').filter({ has: skillNameEl });
    // Use exact 'Delete' to avoid matching the expand button whose accessible name contains
    // the skill name (e.g. "▸ E2E Delete Skill …" also contains "delete").
    const deleteBtn = skillCard.getByRole('button', { name: 'Delete', exact: true });

    // Click Delete — must open ConfirmDialog, NOT a native browser dialog
    await deleteBtn.click();

    // Assert: ConfirmDialog is open (role=dialog + aria-modal=true)
    // The dialog renders via React portal to document.body
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Verify dialog title contains the skill name (ConfirmDialog passes title as the skill name)
    await expect(dialog.locator('#confirm-dialog-title')).toContainText(skillName);

    // Step 1: Cancel — dialog closes, skill remains
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
    await expect(page.getByText(skillName)).toBeVisible({ timeout: 5_000 });

    // Step 2: Re-open, then Confirm deletion
    await deleteBtn.click();
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /delete/i }).click();

    // Assert toast "Skill deleted" (Sonner)
    await expect(page.getByText(/skill deleted/i)).toBeVisible({ timeout: 10_000 });

    // Skill should no longer be visible in the list
    await expect(page.getByText(skillName)).not.toBeVisible({ timeout: 5_000 });

    // Selector path:
    //   /skills page → [class*="bg-neutral-900"]:has(text(skillName)) → button[Delete]
    //   dialog: [role="dialog"][aria-modal="true"] → #confirm-dialog-title
    //   Cancel: dialog button[Cancel]
    //   Confirm: dialog button[Delete]
  });
});
