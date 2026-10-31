import { test, expect } from '@playwright/test';
// Offline single-player flow with the demo level (no paid calls).
test('play: load level, wrong click, finish state visible', async ({ page }) => {
  await page.goto('/play');
  await expect(page.getByRole('button', { name: /New demo level/ })).toBeVisible();
  await expect(page.getByText(/Found 0\//)).toBeVisible();
  await page.locator('svg').nth(1).click({ position: { x: 5, y: 5 } });
  await expect(page.getByText(/Found|Not there/).first()).toBeVisible();
});
