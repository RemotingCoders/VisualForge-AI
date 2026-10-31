import { test, expect } from '@playwright/test';
// Offline smoke flow (no paid calls): the page offers level creation + the
// gallery; the demo board was removed once real generation shipped.
test('play: create section, empty board placeholder and gallery render', async ({ page }) => {
  await page.goto('/play');
  await expect(page.getByRole('button', { name: /Generate level/ })).toBeVisible();
  await expect(page.getByText('Your level will appear here')).toBeVisible();
  await expect(page.getByText(/Found 0\//)).toBeVisible();
});
