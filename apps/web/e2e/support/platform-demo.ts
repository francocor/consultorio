import { expect, type Page } from '@playwright/test';

import { WEB_PORT, originOf, stack, urlOf, type Organization } from './stack.js';

/**
 * The billed organizations of the platform demo (`pnpm demo:platform`), which the end-to-end stack
 * creates: a trial, an active subscription (with a professional and the statement of the month that
 * closed), a charge that failed and a read-only organization. They are built by the real services of
 * the subscription module with a clock of the seed, so a journey can start from a state that takes
 * weeks to reach. A journey that CHANGES one (pays the overdue amount) uses it once per stack.
 */
export type PlatformState = keyof typeof stack.platformDemo;

export const platformOrg = (state: PlatformState) => stack.platformDemo[state];

export const orgUrl = (slug: string, path = '/') => urlOf(slug as Organization, path);

/** Signs a member of one of these organizations in, through the web app's own proxy. */
export async function signInTo(page: Page, slug: string, email: string): Promise<void> {
  const organization = slug as Organization;
  const response = await page.request.post(orgUrl(slug, '/api/auth/login'), {
    data: { email, password: stack.demoPassword },
    headers: { origin: originOf(organization) },
  });
  expect(response.ok(), `sign in as ${email}`).toBe(true);
}

/**
 * The links the API writes for the hosted page and for the way back have no port (the stack has no
 * public port), so the browser would look for them on port 80. They are sent to the preview server
 * instead, the way `localLink` does for an email.
 */
export async function reachLocalAddresses(page: Page): Promise<void> {
  await page.route(/\.localhost(:\d+)?\/(api\/local-providers|subscription)/, (route) => {
    const url = new URL(route.request().url());
    if (url.port === String(WEB_PORT)) return route.fallback();
    url.port = String(WEB_PORT);
    return route.fulfill({ status: 302, headers: { location: url.toString() } });
  });
}
