import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

// Independent storageState — this file tests the full login/logout cycle
// from scratch and must NOT share auth state with other specs.
test.use({ storageState: { cookies: [], origins: [] } });

const E2E_EMAIL = 'e2e-playwright@nodalai.local';
const E2E_PASSWORD = 'E2ETest_pw_2026!';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('UserMenu — sign-out + re-login round-trip', () => {
  test('shows email in sidebar, signs out, redirects to /login, re-logs in', async ({ page }) => {
    // ── Sign in via the login form ──────────────────────────────────────────
    // Skip the test in local-trust mode — no /login form, no sign-out flow.
    await page.goto('/login');

    // La garde de mode existait déjà — elle ne pouvait simplement jamais se
    // déclencher. Elle cherchait « local trust mode », avec une ESPACE ; la
    // page écrit « local-trust », avec un trait d'union (LocalTrustBanner), et
    // le mot « mode » y est séparé du terme par une balise <code>. Le parcours
    // continuait donc sur une page sans formulaire, et la mesure nocturne
    // rougissait au lieu d'ignorer :
    //
    //   TimeoutError: locator.fill: Timeout 10000ms exceeded.
    //   waiting for locator('[data-testid="email-input"]')
    //
    // On s'accroche maintenant au TITRE de la bannière, qui est ce que la page
    // affirme d'elle-même. En local-trust il n'y a ni /login, ni déconnexion,
    // ni re-connexion : ce parcours n'a pas d'objet, et le dit.
    if (
      await page
        .getByRole('heading', { name: /local mode active/i })
        .isVisible({ timeout: 5_000 })
        .catch(() => false)
    ) {
      test.skip(
        true,
        "AUTH_MODE=local-trust : le dashboard est ouvert par conception, il n'y a ni " +
          'formulaire de connexion ni déconnexion à éprouver. Rejouer ce parcours demande ' +
          'une pile en local-auth (nodal-agents init → LAN).',
      );
    }

    await page.locator('[data-testid="email-input"]').fill(E2E_EMAIL);
    await page.locator('[data-testid="password-input"]').fill(E2E_PASSWORD);
    await page.locator('[data-testid="login-button"]').click();

    // Land on the dashboard.
    await page.waitForURL(/\/(agents|onboarding|stats)(\?|$)/, { timeout: 10_000 });

    // ── UserMenu visible with email ──────────────────────────────────────────
    const userMenu = page.locator('[data-testid="user-menu"]');
    await expect(userMenu).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="user-menu-email"]')).toContainText(E2E_EMAIL);

    // ── Sign out ─────────────────────────────────────────────────────────────
    await page.locator('[data-testid="user-menu-sign-out"]').click();
    await page.waitForURL(/\/login(\?|$)/, { timeout: 10_000 });

    // ── Protected route now redirects to /login ──────────────────────────────
    await page.goto('/agents');
    await page.waitForURL(/\/login(\?|$)/, { timeout: 5_000 });

    // ── Re-login restores session ────────────────────────────────────────────
    await page.locator('[data-testid="email-input"]').fill(E2E_EMAIL);
    await page.locator('[data-testid="password-input"]').fill(E2E_PASSWORD);
    await page.locator('[data-testid="login-button"]').click();
    await page.waitForURL(/\/(agents|onboarding|stats)(\?|$)/, { timeout: 10_000 });
    await expect(page.locator('[data-testid="user-menu-email"]')).toContainText(E2E_EMAIL);
  });
});
