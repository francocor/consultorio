import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('built shell', () => {
  test('loads the tenant-neutral placeholder', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'es-AR');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Aplicación en preparación');
  });

  test('has no accessibility violations (WCAG 2.2 AA)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('does not scroll horizontally', async ({ page }) => {
    await page.goto('/');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
