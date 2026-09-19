/**
 * Playwright e2e — the boot journey: the dashboard opens, every section is
 * reachable, and an agent can be created and given a task.
 *
 * Realigned 2026-08-10. This spec had drifted behind two UI passes and was
 * asserting a product that no longer exists:
 *   - `/billing` — deleted in b29bdf2 (the 0.6.3 design pass)
 *   - `/stats`   — folded into the dashboard in 9c43de6 ("merge Home + Stats
 *                  into a single root page"); the dashboard itself left the
 *                  root for `/dashboard` on 2026-09-19 (#248), and `/` is now
 *                  a conversation that has not started
 *   - sidebar labels 'Stats', 'Jobs', 'Memories', 'Billing' — now 'Home',
 *     'Runs', 'Memory', and gone, respectively
 *
 * The route list and the labels below are read from the real source of truth
 * (`components/sidebar-nav.ts` and the `(dashboard)` route folder). When a
 * section is added or renamed, this list is what must move with it.
 *
 * Realigned again 2026-09-19 (#230): la barre est devenue un RAIL de trois
 * destinations et un PANNEAU pour celle qui est active. Un seul panneau est
 * visible à la fois, donc « toutes les entrées visibles sur une page » n'est
 * plus vrai — et ne doit plus être demandé.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, testSlugSuffix } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('dashboard navigation @cap:installer-et-demarrer/ecran', () => {
  test('the root page IS a new conversation — no login form, no redirect away', async ({
    page,
  }) => {
    const response = await page.goto('/');

    // In local-trust the app is open; in local-auth the session cookie
    // injected by global-setup carries us through. Either way the one thing
    // that must never happen is landing on the login form. Onboarding is a
    // legitimate destination on a stack with no agent created yet.
    expect(page.url()).not.toMatch(/\/login/);
    expect(response?.status(), 'root page HTTP status').toBeLessThan(400);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

    // #248 — the root is the empty thread: the greeting and the composer, not
    // the dashboard's metric cards. Skipped on a stack still in onboarding,
    // which has no ROOT agent and therefore no composer to show.
    if (!page.url().includes('/onboarding')) {
      await expect(page.getByText(/what are we building today\?/i)).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText('Total jobs')).toHaveCount(0);
    }
  });

  test('the dashboard moved to /dashboard, and nothing redirects back to the root', async ({
    page,
  }) => {
    const response = await page.goto('/dashboard');
    expect(response?.status(), '/dashboard HTTP status').toBeLessThan(400);
    if (page.url().includes('/onboarding')) test.skip();
    expect(new URL(page.url()).pathname, 'no redirect away from /dashboard').toBe('/dashboard');
    await expect(page.getByText('Total jobs')).toBeVisible({ timeout: 10_000 });
  });

  test('the rail carries the three destinations on every page', async ({ page }) => {
    await page.goto('/agents');
    // Depuis #230 la barre est un RAIL de destinations et un PANNEAU pour
    // celle qui est active. Le rail, lui, est le même partout.
    for (const key of ['work', 'agent', 'run', 'approvals', 'settings', 'help']) {
      await expect(page.locator(`[data-testid="rail-${key}"]`), `rail cell "${key}"`).toBeVisible();
    }
    // Et c'est bien Agent qui est allumee sur /agents.
    await expect(page.locator('[data-testid="rail-agent"]')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('every dashboard section is one panel away', async ({ page }) => {
    // Un panneau ne montre que SA destination : la liste plate d'avant #230
    // aurait demandé que tout soit visible à la fois, ce qui n'est plus vrai.
    // Les libellés sont ceux de `components/sidebar-nav.ts`, la source.
    const panneaux: ReadonlyArray<readonly [string, readonly string[]]> = [
      [
        '/agents',
        [
          'Agents',
          'Skills',
          'Learned Skills',
          'Memory',
          'API Connectors',
          'MCP Connectors',
          'Credentials',
          'LLM Providers',
        ],
      ],
      [
        // `/logs`, et PLUS `/` : la racine ouvre le panneau Work depuis
        // l'issue #248. `/logs` est une route de Run qui EXISTE aujourd'hui —
        // `/dashboard`, ou la page du tableau de bord demenage, n'arrive
        // qu'avec la PR de l'ecran d'accueil, et un parcours ne visite pas une
        // adresse qui n'est pas encore la.
        '/logs',
        [
          // 'Home' jusqu'au 18/09/2026 : la barre dit maintenant 'Dashboard'.
          // Les ROUTES, elles, n'ont pas bouge.
          'Dashboard',
          // « Runs » n'est plus une entree du menu depuis #134 : la liste des
          // runs EST Activity, le premier onglet de Logs.
          'Logs',
          'Automations & Webhooks',
        ],
      ],
    ];

    for (const [route, labels] of panneaux) {
      await page.goto(route);
      const panneau = page.locator('[data-testid="sidebar-panel"]');
      for (const label of labels) {
        await expect(
          panneau.getByRole('link', { name: new RegExp(label, 'i') }).first(),
          `panel link "${label}" on ${route}`,
        ).toBeVisible();
      }
    }

    // Les espaces de travail ne sont PAS un lien : depuis le 19/09/2026 au
    // soir, « Workspaces » est un DOSSIER du panneau Work, comme un canal. Sa
    // ligne est un bouton qui plie et deplie ; le chemin vers `/spaces` est le
    // « See all » de son sous-menu, une fois deplie.
    await page.goto('/chat');
    const dossier = page.locator('[data-testid="inbox-folder-workspaces"]');
    await expect(dossier).toBeVisible();
    await expect(dossier).toHaveAttribute('aria-expanded', 'false');
    await dossier.click();
    await expect(dossier).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-testid="folder-see-all-workspaces"]')).toHaveAttribute(
      'href',
      '/spaces',
    );

    // Settings et Approvals vivent sur le RAIL, pas dans un panneau : ce qui
    // attend une reponse se voit de n'importe quelle destination.
    await expect(page.locator('[data-testid="rail-settings"]')).toBeVisible();
    await expect(page.locator('[data-testid="rail-approvals"]')).toHaveAttribute(
      'href',
      '/approvals',
    );
  });

  test('the Work panel lists the channels and the recent threads', async ({ page }) => {
    await page.goto('/chat');
    const panneau = page.locator('[data-testid="sidebar-panel"]');
    await expect(panneau).toHaveAttribute('aria-label', 'Work');
    // « Nodal chats » est une destination permanente du produit : son dossier
    // est là même sur une base vide. C'est un bouton — il PLIE, il ne navigue
    // pas (#206) — et « See all » est ce qui ouvre la liste.
    await expect(page.locator('[data-testid="inbox-folder-dashboard"]')).toBeVisible();
    await expect(page.locator('[data-testid="recent-see-all"]')).toBeVisible();
  });
});

test.describe('agent → task → job flow @cap:creer-agent/ecran @cap:parler-a-un-agent/ecran', () => {
  test('creates an agent, sends a task, and shows the job in the list', async ({ page }) => {
    await page.goto('/agents');

    const slug = testSlugSuffix();
    const agentName = `E2E Agent ${slug}`;

    // ── Create agent ──────────────────────────────────────────────────────
    // "New agent" opens the profile picker first (PR #45); "Customize a new
    // agent" is selected by default and Next opens the plain form this smoke
    // has always exercised.
    await page.getByRole('button', { name: /new agent/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Next' }).click();
    // Modal is rendered via createPortal — wait for it to appear in the DOM.
    const slugInput = page.locator('#agent-slug');
    await slugInput.waitFor({ state: 'visible', timeout: 5_000 });
    await slugInput.fill(slug);
    await page.locator('#agent-name').fill(agentName);
    await page.locator('#agent-personality').fill('You are helpful.');
    // Model: the field is a DROPDOWN only when the selected provider ships a
    // model catalog. With a provider that has none — "Local LLM", for instance —
    // the same `#agent-model` id belongs to a free-text input instead
    // (AgentForm.tsx: `modelInDropdown`).
    //
    // This used to assume a <select> unconditionally: it found zero <option>,
    // filled nothing, and the browser's own "Please fill out this field"
    // blocked submit. The test then failed on the agent never appearing — a
    // fixture problem wearing the mask of a product bug. It passed in CI only
    // because that environment has no LLM key at all, so it went down a
    // different path (diagnosed from the failure screenshot, 2026-08-21).
    const modelField = page.locator('#agent-model');
    await expect(modelField).toBeVisible({ timeout: 5_000 });
    const isSelect = (await modelField.evaluate((el) => el.tagName)) === 'SELECT';
    if (isSelect) {
      const values = await modelField
        .locator('option')
        .evaluateAll((opts) =>
          opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v && v !== '__custom__'),
        );
      expect(values.length, 'the model dropdown offered nothing to pick').toBeGreaterThan(0);
      await modelField.selectOption(values[0]!);
    } else {
      // Free-text: any non-empty id satisfies the form. The job never runs in
      // this test, so the model only has to be syntactically acceptable.
      await modelField.fill('e2e-test-model');
    }
    await page.getByRole('button', { name: /create agent/i }).click();

    // Wait for the agent name to appear in the table.
    await expect(page.getByText(agentName)).toBeVisible({ timeout: 10_000 });

    // ── Send task ─────────────────────────────────────────────────────────
    // SendTaskForm lives on the runs list, which is Activity since #134 (it
    // creates an agent_jobs row and redirects to /jobs/<id>). /tasks is
    // reserved for the planner orchestrator's task board.
    await page.goto('/logs');
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

test.describe('settings pages render without runtime errors @cap:installer-et-demarrer/ecran', () => {
  test('every (dashboard) route returns 200 and renders an h1', async ({ page }) => {
    // Every folder under src/app/(dashboard), plus the root page itself.
    const routes = [
      '/',
      // #248 — le Dashboard a quitté la racine pour cette adresse.
      '/dashboard',
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

  // Les routes à paramètre étaient le trou de cette liste : 15 routes statiques
  // chargées, et zéro des 7 qui portent un id. Ce sont pourtant les pages où
  // l'on passe le plus de temps — l'éditeur d'agent, le détail d'un run. On les
  // atteint par les liens de l'application plutôt qu'en fabriquant des ids :
  // un id inventé prouverait seulement que la page sait rendre un 404.
  test('les routes à paramètre rendent, atteintes par les liens de l’app', async ({ page }) => {
    await page.goto('/agents');
    const lienEdition = page.locator('a[href*="/agents/"][href$="/edit"]').first();
    await expect(lienEdition, 'aucun agent dans la liste — le parcours amont a échoué').toBeVisible(
      {
        timeout: 10_000,
      },
    );

    const hrefEdition = await lienEdition.getAttribute('href');
    const rEdition = await page.goto(hrefEdition!);
    expect(rEdition?.status(), `${hrefEdition} HTTP status`).toBeLessThan(400);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

    // Le détail d'un run n'existe que s'il y a eu un run. Sur une installation
    // fraîche il n'y en a pas, et exiger le contraire ferait échouer la CI pour
    // une raison qui n'est pas un défaut — on saute, en le disant.
    //
    // La liste des runs est Activity depuis #134 : un run s'atteint en dépliant
    // sa ligne, qui porte alors le lien « Open run ». C'est le chemin qu'un
    // lecteur prend, et donc celui qu'on vérifie.
    await page.goto('/logs');
    const ligneRun = page.locator('[data-testid^="run-row-"]').first();
    if ((await ligneRun.count()) === 0) {
      test.info().annotations.push({ type: 'skip', description: 'aucun run dans cet espace' });
      return;
    }
    await ligneRun.click();
    const lienRun = page.getByRole('link', { name: /open run/i }).first();
    await expect(lienRun, 'une ligne dépliée sans lien vers son run').toBeVisible({
      timeout: 10_000,
    });
    const hrefRun = await lienRun.getAttribute('href');
    const rRun = await page.goto(hrefRun!);
    expect(rRun?.status(), `${hrefRun} HTTP status`).toBeLessThan(400);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });
  });
});
