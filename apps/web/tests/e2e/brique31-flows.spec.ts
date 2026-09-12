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
import { requireLiveStack, testSlugSuffix, makeDbClient, resolveActingUser } from './helpers.ts';

/**
 * L'espace au nom duquel le dashboard agit.
 *
 * Cherchait `e2e-playwright@nodalai.local` en dur, donc rendait `null` en
 * local-trust (le mode par défaut) : les cas C, D et E se déclaraient
 * « ignorés, espace e2e introuvable » sur toutes les mesures nocturnes, pour
 * une raison qui n'était pas la bonne.
 */
async function getE2eEntityId(): Promise<string | null> {
  const { entityId } = await resolveActingUser();
  return entityId;
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
    await page.goto('/llm-providers');

    // Le bouton de la barre d'outils s'appelle « + New provider ».
    // « Add provider » est le bouton de SOUMISSION du formulaire, qui n'existe
    // qu'une fois le formulaire ouvert : le parcours attendait donc, sur une
    // page au repos, un bouton qui ne pouvait pas y être. Message du 11/09 :
    //
    //   TimeoutError: locator.click: Timeout 10000ms exceeded.
    //   waiting for getByRole('button', { name: /add provider/i })
    await page.getByRole('button', { name: /new provider/i }).click();

    const providerSelect = page.locator('#llm-provider');
    await providerSelect.waitFor({ state: 'visible', timeout: 5_000 });
    await providerSelect.selectOption('anthropic');

    await page.locator('#llm-base-url').fill('https://api.anthropic.com/v1');
    await page.locator('#llm-api-key').fill('sk-ant-e2e-test-key-placeholder'); // secrets:allow (fake placeholder)

    // Le verdict du test de connexion, désigné par son ancre. Le parcours le
    // cherchait par ses classes (`.bg-emerald-500/10` / `.bg-red-500/10`), qui
    // n'existent plus depuis le passage aux jetons du design system.
    await page.getByRole('button', { name: /test connection/i }).click();
    const verdict = page.getByTestId('llm-test-result');
    await expect(verdict).toBeVisible({ timeout: 20_000 });

    // Le verdict dit quelque chose — l'UI sait rendre les deux issues. Avec une
    // fausse clé c'est un échec, et c'est une réponse valable : ce qui est
    // prouvé ici, c'est que la chaîne formulaire → action serveur → rendu
    // fonctionne, pas que la clé est bonne.
    const state = await verdict.getAttribute('data-state');
    expect(['pass', 'fail']).toContain(state);
    expect((await verdict.innerText()).trim().length).toBeGreaterThan(0);

    const submit = page.getByRole('button', { name: /add provider/i });
    if (state === 'pass') {
      await submit.click();
      await expect(page.getByText(/anthropic/i).first()).toBeVisible({ timeout: 10_000 });
    } else {
      // Échec du test → l'enregistrement est refusé. C'est le comportement
      // voulu (« Test the connection before saving »), et il se vérifie.
      await expect(submit).toBeDisabled();
    }
  });
});

// ─── Test B — Agent edit picks LLM provider ──────────────────────────────────

test.describe('Test B — Agent edit picks LLM provider', () => {
  test('change LLM provider dropdown on agent edit → model field updates → save → toast', async ({
    page,
  }) => {
    // ⚠️ Ce cas visait une page qui n'existe plus. L'éditeur d'agent est
    // devenu `AgentComposer` à onglets : ni `#agent-llm-key` ni la phrase
    // « No active LLM providers » n'y figurent (ces deux ancres vivent dans
    // `AgentForm`, la modale de création). Les DEUX branches du parcours
    // pointaient donc dans le vide, et c'est la branche de repli qui a rougi :
    //
    //   expect(locator).toBeVisible() failed
    //   Locator: getByText(/no active llm providers/i)
    //   Error: element(s) not found
    //
    // Le réglage vit désormais dans l'onglet « Settings », champ
    // « LLM provider », et le message de repli dit « No active LLM keys. ».
    await page.goto('/agents');
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    const editLinks = page.locator('a[href*="/agents/"][href$="/edit"]');
    if ((await editLinks.count()) === 0) {
      test.skip(true, 'Aucun agent sur cette installation — rien à éditer.');
      return;
    }
    const href = await editLinks.first().getAttribute('href');
    if (!href) {
      test.skip(true, "Le premier agent n'expose pas de lien d'édition.");
      return;
    }

    await page.goto(href);
    await page.waitForURL(/\/agents\/.*\/edit/, { timeout: 10_000 });
    const settingsTab = page.getByRole('tab', { name: /^settings/i }).first();
    await settingsTab.click();
    await expect(settingsTab).toHaveAttribute('aria-selected', 'true', { timeout: 8_000 });

    const noKeys = page.getByText('No active LLM keys.', { exact: false });
    if (await noKeys.isVisible({ timeout: 3_000 }).catch(() => false)) {
      // Repli légitime d'une installation sans clé : le produit doit dire où
      // en ajouter une, pas laisser un menu vide.
      await expect(page.getByRole('link', { name: /add one/i })).toHaveAttribute(
        'href',
        '/llm-providers',
      );
      return;
    }

    // `Field` rend son libellé en `<label>` FRÈRE du contrôle (pas parent, et
    // sans `htmlFor`) : on descend donc par le sélecteur de frère adjacent.
    const providerSelect = page.locator('label:has-text("LLM provider") + div select');
    await expect(providerSelect).toBeVisible({ timeout: 8_000 });

    const optionValues = await providerSelect
      .locator('option')
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    expect(optionValues.length).toBeGreaterThan(0);

    // Le modèle est renseigné : menu si le catalogue en connaît, champ libre
    // sinon — jamais vide, c'est ce que le cas doit prouver.
    const modelControl = page.locator('label:has-text("Model") + div').first();
    await expect(modelControl).toBeVisible({ timeout: 8_000 });
    const modelSelect = modelControl.locator('select').first();
    const modelValue = (await modelSelect.count())
      ? await modelSelect.inputValue()
      : await modelControl.locator('input').first().inputValue();
    expect(modelValue.trim().length).toBeGreaterThan(0);

    if (optionValues.length < 2) {
      // Un seul fournisseur : le basculement n'est pas observable, mais le
      // réglage l'est — et c'est déjà plus que ce que ce cas prouvait.
      return;
    }

    const current = await providerSelect.inputValue();
    const other = optionValues.find((v) => v !== current)!;
    await providerSelect.selectOption(other);
    await expect(providerSelect).toHaveValue(other);

    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText(/agent updated/i)).toBeVisible({ timeout: 10_000 });
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
