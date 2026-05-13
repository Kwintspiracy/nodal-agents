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
    if (
      await page
        .getByText(/local trust mode/i)
        .isVisible({ timeout: 1_000 })
        .catch(() => false)
    ) {
      test.skip(true, 'AUTH_MODE=local-trust — UserMenu sign-out flow not applicable');
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
