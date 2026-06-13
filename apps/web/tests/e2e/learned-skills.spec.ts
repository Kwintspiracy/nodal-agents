import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('learned-skills page', () => {
  test('renders the Learned Skills page at /learned-skills', async ({ page }) => {
    await page.goto('/learned-skills');
    await expect(page.getByRole('heading', { name: 'Learned Skills', level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    // Toggle should be present
    await expect(page.getByRole('switch', { name: /agent learning/i })).toBeVisible();
  });

  test('toggle switches the reflection_enabled flag (UI responds)', async ({ page }) => {
    await page.goto('/learned-skills');

    const toggle = page.getByRole('switch', { name: /agent learning/i });
    await toggle.waitFor({ state: 'visible' });

    const initialChecked = await toggle.getAttribute('aria-checked');
    await toggle.click();
    // After click the aria-checked should have flipped (optimistic UI)
    await expect(toggle).toHaveAttribute(
      'aria-checked',
      initialChecked === 'true' ? 'false' : 'true',
    );
  });

  test('no window.confirm / window.alert / window.prompt is called (dialog uses ConfirmDialog)', async ({
    page,
  }) => {
    // Wire up dialog detectors BEFORE navigating to the page
    const nativeDialogCalled: string[] = [];
    page.on('dialog', (dialog) => {
      nativeDialogCalled.push(dialog.type());
      void dialog.dismiss();
    });

    await page.goto('/learned-skills');

    // The page should render without any native dialogs during load.
    // Any confirm/archive interactions should use ConfirmDialog (portal modal), not window.confirm.
    expect(nativeDialogCalled).toHaveLength(0);
  });
});
