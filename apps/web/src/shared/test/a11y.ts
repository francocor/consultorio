import { configureAxe } from 'vitest-axe';

/**
 * Accessibility checks for component tests.
 *
 * jsdom has no layout engine, so the colour-contrast rule cannot run here. Contrast is covered by
 * the Playwright + axe check in `e2e/`, which runs in a real browser.
 */
const axe = configureAxe({
  rules: { 'color-contrast': { enabled: false } },
});

/** Returns the WCAG violations axe finds in the element. An empty list means it passed. */
export async function a11yViolations(element: Element) {
  const results = await axe(element);
  return results.violations;
}
