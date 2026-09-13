/**
 * Playwright e2e — Brique 34 v3.1: help guide smoke tests.
 *
 * Scenario A: Google Drive wizard shows all 4 API direct links + format hint.
 * Scenario B: Apify connector "Where do I get this?" expander reveals the
 *             console.apify.com link.
 *
 * Requires a running Nodal-Agents stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, cleanCredentialsByType, openConnectorInstallDialog } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
  // Ensure Google Drive shows the "Connect with Google" wizard button.
  await cleanCredentialsByType('google-oauth');
});

test.describe('Help guides — OAuth wizard (Google Drive) @cap:consulter-l-aide', () => {
  test('wizard shows 4 Google API links and format hint', async ({ page }) => {
    // Le catalogue est derrière l'onglet « Library », et le bouton s'appelle
    // « Install » depuis la refonte — la mesure du 11/09 expirait sur l'ancien
    // libellé « Connect with Google ». Aucun identifiant google-oauth
    // n'existant (beforeAll), la carte ouvre bien le CredentialWizard.
    await openConnectorInstallDialog(page, 'Google Drive');

    const wizard = page.getByRole('dialog');
    await expect(wizard).toBeVisible({ timeout: 5_000 });

    // ── Assert the 4 Google API direct links ──────────────────────────────────
    await expect(wizard.getByRole('link', { name: /drive api/i })).toBeVisible({ timeout: 5_000 });
    await expect(wizard.getByRole('link', { name: /gmail api/i })).toBeVisible();
    await expect(wizard.getByRole('link', { name: /sheets api/i })).toBeVisible();
    await expect(wizard.getByRole('link', { name: /docs api/i })).toBeVisible();

    // Verify the Drive API link points to the correct URL.
    const driveLink = wizard.getByRole('link', { name: /drive api/i });
    await expect(driveLink).toHaveAttribute(
      'href',
      'https://console.cloud.google.com/apis/library/drive.googleapis.com',
    );

    // ── Assert the format hint contains apps.googleusercontent.com ────────────
    await expect(wizard.getByText(/apps\.googleusercontent\.com/)).toBeVisible();

    // Fermeture par le bouton Cancel, PAS par Échap : l'assistant est ouvert
    // avec un type imposé, donc à l'étape « formulaire », et cette étape est
    // délibérément non-dismissable (elle contient un brouillon d'identifiants,
    // règle UX-B7). Échap n'y ferme rien.
    await wizard.getByRole('button', { name: /^cancel$/i }).click();
    await expect(wizard).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe('Help guides — api_key connector (Apify) @cap:consulter-l-aide', () => {
  test('"Where do I get this?" expander reveals console.apify.com link', async ({ page }) => {
    // Même refonte côté api_key : « Install », et le formulaire s'ouvre dans
    // une MODALE, plus dans la carte. La mesure du 11/09 expirait sur
    //   .getByRole('button', { name: /^connect$/i }) — un bouton qui n'a
    // jamais existé sur la carte.
    await openConnectorInstallDialog(page, 'Apify');
    const apifyDialog = page.getByRole('dialog');

    // The api_key input should be visible.
    await expect(apifyDialog.locator('input[name="apiKey"]')).toBeVisible({ timeout: 5_000 });

    // The details summary should be present (collapsed by default — link not yet visible).
    const summary = apifyDialog.getByText(/where do i get this\?/i);
    await expect(summary).toBeVisible();

    // The apify link should NOT be visible before expanding.
    const apifyLink = apifyDialog.getByRole('link', { name: /console\.apify\.com/i });
    await expect(apifyLink).not.toBeVisible();

    // Click the summary to expand the details.
    await summary.click();

    // Now the link should be visible.
    await expect(apifyLink).toBeVisible({ timeout: 3_000 });
    await expect(apifyLink).toHaveAttribute(
      'href',
      'https://console.apify.com/account/integrations',
    );
  });
});
