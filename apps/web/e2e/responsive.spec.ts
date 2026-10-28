import { expect, test, type Page } from '@playwright/test';

import { clippedLabels, hitHeight, layoutProblems, overlappingBoxes } from './support/layout.js';
import {
  emailOf,
  horizontalOverflow,
  openAs,
  signInWithApi,
  urlOf,
  type AccountKey,
} from './support/stack.js';

/**
 * Every screen of the staff app, the public pages and the portal sign-in at the two widths the
 * design system names: a phone (375 px, bottom bar) and a tablet (768 px, sidebar). The page must
 * not scroll sideways, nothing may be cut off by a box that does not scroll, and no control may
 * show half its own label. Read-only: it signs in and looks.
 *
 * The narrowest phone (360 px) has its own specs (`*.responsive.spec.ts`) that also check WCAG;
 * this one is the sweep over the whole product, so a screen added later is checked at both widths
 * by adding one line to `SCREENS`.
 */
const VIEWPORTS = [
  { label: 'phone', width: 375, height: 812 },
  { label: 'tablet', width: 768, height: 1024 },
] as const;

interface Screen {
  name: string;
  /** Who looks at it; `null` for a page a visitor sees. */
  account: AccountKey | null;
  path: string;
}

const SCREENS: Screen[] = [
  // Public pages and the portal sign-in.
  { name: 'sign-in', account: null, path: '/login' },
  { name: 'forgot password', account: null, path: '/forgot-password' },
  { name: 'public booking', account: null, path: '/book/aillu' },
  { name: 'portal sign-in', account: null, path: '/portal' },
  // The owner sees every administrative screen.
  { name: 'home', account: 'owner', path: '/' },
  { name: 'account security', account: 'owner', path: '/account/security' },
  { name: 'agenda, week', account: 'owner', path: '/calendar?view=week' },
  { name: 'agenda, month', account: 'owner', path: '/calendar?view=month' },
  { name: 'worklist', account: 'owner', path: '/worklist' },
  { name: 'waiting list', account: 'owner', path: '/waitlist' },
  { name: 'patients', account: 'owner', path: '/patients' },
  { name: 'new patient', account: 'owner', path: '/patients/new' },
  { name: 'consents', account: 'owner', path: '/consents' },
  { name: 'charges', account: 'owner', path: '/charges' },
  { name: 'cash', account: 'owner', path: '/cash' },
  { name: 'invoices', account: 'owner', path: '/invoices' },
  { name: 'reports, turns', account: 'owner', path: '/reports' },
  { name: 'reports, money', account: 'owner', path: '/reports/financial' },
  { name: 'reports, cash', account: 'owner', path: '/reports/cash' },
  { name: 'team', account: 'owner', path: '/staff' },
  { name: 'settings, places', account: 'owner', path: '/settings/locations' },
  { name: 'settings, scheduling', account: 'owner', path: '/settings/scheduling' },
  { name: 'settings, branding', account: 'owner', path: '/settings/branding' },
  { name: 'settings, security', account: 'owner', path: '/settings/security' },
  { name: 'settings, prices', account: 'owner', path: '/settings/prices' },
  { name: 'settings, invoicing', account: 'owner', path: '/settings/invoicing' },
  { name: 'settings, messages', account: 'owner', path: '/settings/messaging' },
  { name: 'settings, online booking', account: 'owner', path: '/settings/online-booking' },
  { name: 'audit', account: 'owner', path: '/audit' },
  { name: 'export', account: 'owner', path: '/export' },
  { name: 'subscription', account: 'owner', path: '/subscription' },
  { name: 'setup checklist', account: 'owner', path: '/onboarding' },
  // The front desk.
  { name: 'agenda, day', account: 'reception', path: '/calendar' },
  { name: 'agenda, list', account: 'reception', path: '/calendar?view=week&list=true' },
  { name: 'arrivals', account: 'reception', path: '/check-in' },
  // A professional.
  { name: 'today', account: 'cardiology', path: '/today' },
  { name: 'drafts', account: 'cardiology', path: '/drafts' },
  { name: 'prescriptions', account: 'cardiology', path: '/prescriptions' },
  { name: 'clinical export', account: 'cardiology', path: '/export/clinical' },
];

/** The page is drawn: a heading, and no request still in flight. */
async function settled(page: Page) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

async function visit(page: Page, screen: Screen) {
  if (screen.account === null) {
    await page.goto(urlOf('aillu', screen.path));
  } else {
    await openAs(page, screen.account, screen.path);
  }
  await settled(page);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.label} (${String(viewport.width)} px)`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.width < 768,
      hasTouch: viewport.width < 768,
    });

    for (const screen of SCREENS) {
      test(`${screen.name} fits the screen`, async ({ page }) => {
        await visit(page, screen);

        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
        expect(await layoutProblems(page)).toEqual([]);
        expect(await clippedLabels(page)).toEqual([]);
      });
    }

    test('the patient record and its tabs fit the screen', async ({ page }) => {
      await openAs(page, 'cardiology', '/patients');
      await page.getByRole('link', { name: /Gómez, Valentina/ }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Valentina Gómez' })).toBeVisible();

      for (const tab of await page.getByRole('tab').all()) {
        await tab.click();
        await page.waitForLoadState('networkidle');
        expect(await horizontalOverflow(page), (await tab.textContent()) ?? '').toBeLessThanOrEqual(
          0,
        );
        expect(await clippedLabels(page)).toEqual([]);
      }
    });

    for (const dialogCase of [
      { path: '/calendar', opener: 'Nuevo turno', title: 'Nuevo turno' },
      { path: '/waitlist', opener: 'Agregar a la lista', title: 'Agregar a la lista de espera' },
    ]) {
      test(`the dialog "${dialogCase.title}" fits the screen and every button can be reached`, async ({
        page,
      }) => {
        await openAs(page, 'reception', dialogCase.path);
        await settled(page);
        await page.getByRole('button', { name: dialogCase.opener }).first().click();
        const dialog = page.getByRole('dialog', { name: dialogCase.title });
        await expect(dialog).toBeVisible();

        const box = await dialog.boundingBox();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
        // A tall form scrolls inside the dialog: scroll to each button and see that it is on screen.
        for (const button of await dialog.getByRole('button').all()) {
          await button.scrollIntoViewIfNeeded();
          await expect(button).toBeInViewport();
        }
      });
    }

    test('the other sessions of an account sit beside their button, not under it', async ({
      page,
      request,
    }) => {
      // A second sign-in of the same person: the first one now lists it, with a button to close it.
      await signInWithApi(request, 'aillu', emailOf('owner'));
      await openAs(page, 'owner', '/account/security');
      await expect(page.getByRole('button', { name: 'Cerrar esta sesión' }).first()).toBeVisible();

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await overlappingBoxes(page, 'main li', 'button')).toEqual([]);
    });
  });
}

test.describe('a phone: what a finger can hit', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  /** The target size of the design system on phones. */
  const MINIMUM = 44;

  test('the text links of the sign-in screens have a target of 44 px', async ({ page }) => {
    await page.goto(urlOf('aillu', '/login'));
    await settled(page);
    expect(
      await hitHeight(page.getByRole('link', { name: '¿Olvidó su contraseña?' })),
    ).toBeGreaterThanOrEqual(MINIMUM);

    await page.goto(urlOf('aillu', '/forgot-password'));
    await settled(page);
    expect(
      await hitHeight(page.getByRole('link', { name: 'Volver a iniciar sesión' })),
    ).toBeGreaterThanOrEqual(MINIMUM);
  });

  test('the "back" link of a patient screen has a target of 44 px', async ({ page }) => {
    await openAs(page, 'owner', '/patients/new');
    await settled(page);
    expect(
      await hitHeight(page.getByRole('link', { name: 'Volver a pacientes' })),
    ).toBeGreaterThanOrEqual(MINIMUM);
  });

  test('a switch has a target of 44 px', async ({ page }) => {
    await openAs(page, 'owner', '/staff');
    await settled(page);
    expect(await hitHeight(page.getByRole('switch').first())).toBeGreaterThanOrEqual(MINIMUM);
  });
});
