import { expect, test, type Page } from '@playwright/test';

import { patientIdByDocument } from './support/clinical.js';
import { horizontalOverflow, openAs, urlOf } from './support/stack.js';

/**
 * The tabs of the patient record at 360 px, clicked with a pointer. The record of a professional
 * has a dozen tabs (the ones of the record plus the ones the features contribute: coverage,
 * prescriptions, consents...), more than a phone shows at once. A click on a tab must open THAT
 * tab, wherever it sits in the row, and the tab that is open must be in view.
 */
test.use({ reducedMotion: 'reduce' });

/** The patient the cardiologist treats (the clinical journeys use others). */
const PATIENT_DOCUMENT = '99000003';

/** True when the whole tab is inside the strip of tabs (nothing of it is cut off or hidden). */
async function tabIsInView(page: Page, name: string): Promise<boolean> {
  return page.getByRole('tab', { name, exact: true }).evaluate((tab) => {
    const row = tab.closest('[role="tablist"]');
    if (!row) return false;
    const mine = tab.getBoundingClientRect();
    const strip = row.getBoundingClientRect();
    const viewport = window.innerWidth;
    return (
      mine.left >= Math.max(strip.left, 0) - 1 &&
      mine.right <= Math.min(strip.right, viewport) + 1 &&
      mine.width > 0
    );
  });
}

async function openRecord(page: Page) {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, PATIENT_DOCUMENT);
  await page.goto(urlOf('aillu', `/patients/${patientId}`));
  await expect(page.getByRole('tablist')).toBeVisible();
}

test('every tab of the record opens when it is clicked, whichever way the row is walked', async ({
  page,
}) => {
  await openRecord(page);
  const names = (await page.getByRole('tab').allTextContents()).map((name) => name.trim());
  // The features contribute tabs: the ones this journey exists for must be there.
  expect(names).toEqual(expect.arrayContaining(['Recetas', 'Consentimientos']));
  expect(names.length).toBeGreaterThan(8);

  for (const order of [names, [...names].reverse(), ['Recetas', 'Consentimientos', 'Recetas']]) {
    for (const name of order) {
      const tab = page.getByRole('tab', { name, exact: true });
      await tab.click();
      await expect(tab, `clicking "${name}" opens "${name}"`).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      expect(await tabIsInView(page, name), `"${name}" is in view once it is open`).toBe(true);
    }
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('the tab that is open is in view when the record is opened from a link to a far tab', async ({
  page,
}) => {
  await openRecord(page);
  // Open a tab by the keyboard, the way a screen reader user walks the row: the end of the row.
  await page.getByRole('tab').first().focus();
  await page.keyboard.press('End');
  const last = (await page.getByRole('tab').allTextContents()).at(-1)?.trim() ?? '';
  await expect(page.getByRole('tab', { selected: true })).toHaveText(last);
  expect(await tabIsInView(page, last), 'the last tab is in view once it is open').toBe(true);
});
