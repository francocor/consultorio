import { expect, test, type Page } from '@playwright/test';

import { emailOf, openAs, originOf, signInWithApi, urlOf } from './support/stack.js';

/** The primary color the page painted, read as early as the browser allows. */
async function paintedPrimary(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page
    .evaluate(() => ({
      primary: document.documentElement.style.getPropertyValue('--primary'),
      holdingPaint: document.documentElement.getAttribute('data-boot'),
    }))
    .then(({ primary, holdingPaint }) => {
      // A returning visitor's theme is applied before the first paint: nothing is held back.
      expect(holdingPaint).toBeNull();
      return primary;
    });
}

test('a branding change applies after a reload with no flash, and another organization keeps its own theme', async ({
  page,
  browser,
}) => {
  // Visit both organizations once so each host has its theme remembered.
  const aillu = await (await browser.newContext()).newPage();
  await aillu.goto(urlOf('aillu', '/login'));
  await expect(aillu.getByLabel('Correo electrónico')).toBeVisible();
  const ailluBefore = await paintedPrimary(aillu, urlOf('aillu', '/login'));

  await openAs(page, 'owner', '/settings/branding', 'norte');
  await expect(page.getByRole('heading', { level: 2, name: 'Identidad visual' })).toBeVisible();
  const before = (await (await page.request.get(urlOf('norte', '/api/branding'))).json()) as {
    branding: {
      displayName: string;
      shortName: string;
      primaryRequested: string;
      radius: string;
      headingFont: string;
    };
  };

  try {
    await page.getByLabel('Nombre de la organización').fill('Clínica Norte Plus');
    await page.getByLabel('Color principal').fill('#6d28d9');
    await expect(
      page.getByText(/El color se lee bien|no tiene contraste suficiente/),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Guardar identidad' }).click();
    await expect(page.getByText('Identidad guardada.')).toBeVisible();

    // Reload: the new color is on the page by the time the document is parsed.
    const norteAfter = await paintedPrimary(page, urlOf('norte', '/login'));
    expect(norteAfter.toLowerCase()).toBe('#6d28d9');
    await expect(page.getByText(/Clínica Norte Plus/).first()).toBeVisible();

    // The other organization is untouched.
    const ailluAfter = await paintedPrimary(aillu, urlOf('aillu', '/login'));
    expect(ailluAfter).toBe(ailluBefore);
    expect(ailluAfter.toLowerCase()).not.toBe('#6d28d9');
  } finally {
    // Leave the demo organization the way it was found.
    await signInWithApi(page.request, 'norte', emailOf('owner', 'norte'));
    const restore = await page.request.put(urlOf('norte', '/api/branding'), {
      headers: { origin: originOf('norte') },
      data: {
        displayName: before.branding.displayName,
        shortName: before.branding.shortName,
        primaryColor: before.branding.primaryRequested,
        radius: before.branding.radius,
        headingFont: before.branding.headingFont,
      },
    });
    expect(restore.ok()).toBe(true);
  }
});

test('reception cannot open the identity or security settings', async ({ page }) => {
  await openAs(page, 'reception', '/settings/branding');

  await expect(page.getByRole('heading', { name: 'No tiene acceso a esta sección' })).toBeVisible();
  await page.goto(urlOf('aillu', '/settings/security'));
  await expect(page.getByRole('heading', { name: 'No tiene acceso a esta sección' })).toBeVisible();
});

test('the security settings show each policy and the sharing templates', async ({ page }) => {
  await openAs(page, 'owner', '/settings/security');

  await expect(
    page.getByRole('switch', { name: /Exigir la verificación en dos pasos/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('switch', { name: /Recepción ve que existen datos clínicos/ }),
  ).toBeVisible();
  await expect(page.getByRole('switch', { name: /Compartir plantillas clínicas/ })).toBeVisible();
  await expect(page.getByLabel('Desde')).toBeVisible();
});
