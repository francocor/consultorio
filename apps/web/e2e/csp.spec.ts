import { expect, test } from '@playwright/test';

import { openAs, urlOf } from './support/stack.js';

/**
 * ASVS 14.4.7: the web bundle runs under a Content Security Policy that lets scripts come only
 * from its own origin plus the hash of the one inline theme script. The preview server serves the
 * production build with the production policy, so this is the real thing: a violation here is a
 * script, style source, image or request that the policy would block for a person.
 */
test('the shell loads under the Content Security Policy and nothing is blocked', async ({
  page,
}) => {
  const violations: string[] = [];
  const consoleErrors: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { __csp: string[] }).__csp.push(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy/i.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });

  await openAs(page, 'owner');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  for (const path of [
    '/patients',
    '/staff',
    '/audit',
    '/settings/branding',
    '/settings/security',
  ]) {
    await page.goto(urlOf('aillu', path));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    violations.push(
      ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)),
    );
  }

  expect(violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('the page is served with the policy, and its inline script is the hashed one', async ({
  page,
}) => {
  const response = await page.goto(urlOf('aillu', '/login'));
  const policy = response?.headers()['content-security-policy'] ?? '';
  const inline = await page.evaluate(() =>
    [...document.querySelectorAll('script:not([src])')].map((script) => script.textContent),
  );

  expect(policy).toContain("default-src 'self'");
  expect(policy).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(policy).toContain("frame-ancestors 'none'");
  // The one inline script is the theme boot: the browser ran it, so its hash is in the policy.
  expect(inline.filter((code) => code.includes('startThemeBoot'))).toHaveLength(1);
  const canPaint = await page.evaluate(
    () =>
      (window as unknown as { __CONSULTORIO_BOOT__?: unknown }).__CONSULTORIO_BOOT__ !== undefined,
  );
  expect(canPaint).toBe(true);
});
