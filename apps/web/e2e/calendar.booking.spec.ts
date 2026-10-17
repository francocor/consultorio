import { expect, test } from '@playwright/test';

import { bookableProfessional, clockTime } from './support/agenda.js';
import { axeViolations, openAs, originOf, urlOf } from './support/stack.js';

/**
 * Booking is the thing reception does all day (SCH-03): an existing patient, in a handful of
 * actions and well under half a minute. The count is asserted so the flow cannot quietly grow.
 */
const MAX_ACTIONS = 6;
const MAX_SECONDS = 30;

test('reception books an existing patient in a few actions', async ({ page }) => {
  await openAs(page, 'reception', '/');
  const target = await bookableProfessional(page);
  const slot = target.slots[0];
  if (!slot) throw new Error('The demo professional has no free time in the next two weeks');
  const when = clockTime(slot.startsAt);

  // The agenda is already open on the day and the professional: this is where the clock starts.
  await page.goto(urlOf('aillu', `/calendar?date=${slot.date}&pros=${target.professionalId}`));
  await expect(
    page.getByRole('group', { name: `Agenda de ${target.professionalName}` }),
  ).toBeVisible();
  const started = Date.now();
  let actions = 0;

  await page.getByRole('button', { name: 'Nuevo turno' }).click();
  actions += 1;
  const dialog = page.getByRole('dialog', { name: 'Nuevo turno' });
  await dialog
    .getByRole('group', { name: 'Horarios disponibles' })
    .getByRole('button', { name: when, exact: true })
    .click();
  actions += 1;
  await dialog.getByRole('combobox', { name: 'Paciente' }).fill('Gómez');
  actions += 1;
  await dialog.getByRole('option', { name: /Gómez, Valentina/ }).click();
  actions += 1;
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Dar turno' }).click();
  actions += 1;

  await expect(dialog).toBeHidden();
  const column = page.getByRole('group', { name: `Agenda de ${target.professionalName}` });
  await expect(
    column.getByRole('button', { name: new RegExp(`${when}.*Gómez, Valentina`) }),
  ).toBeVisible();

  expect(actions).toBeLessThanOrEqual(MAX_ACTIONS);
  expect((Date.now() - started) / 1000).toBeLessThanOrEqual(MAX_SECONDS);
});

test('when somebody else takes the time first, the next free times are one click away', async ({
  page,
}) => {
  await openAs(page, 'reception', '/');
  const target = await bookableProfessional(page);
  const [mine, , later] = target.slots;
  if (!mine || !later) throw new Error('The demo professional needs three free times');

  await page.goto(urlOf('aillu', `/calendar?date=${mine.date}&pros=${target.professionalId}`));
  await page.getByRole('button', { name: 'Nuevo turno' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo turno' });
  await dialog
    .getByRole('group', { name: 'Horarios disponibles' })
    .getByRole('button', { name: clockTime(mine.startsAt), exact: true })
    .click();
  await dialog.getByRole('combobox', { name: 'Paciente' }).fill('Gómez');
  await dialog.getByRole('option', { name: /Gómez, Valentina/ }).click();

  // The other receptionist books the same time while this dialog is open.
  const patients = (await (
    await page.request.get(urlOf('aillu', '/api/patients?q=Navarro'))
  ).json()) as {
    patients: { id: string }[];
  };
  const other = patients.patients[0];
  if (!other) throw new Error('The demo has no patient to book');
  const taken = await page.request.post(urlOf('aillu', '/api/appointments'), {
    headers: { origin: originOf('aillu') },
    data: {
      patientId: other.id,
      professionalId: target.professionalId,
      locationId: mine.locationId,
      appointmentTypeId: target.typeId,
      startsAt: mine.startsAt,
    },
  });
  expect(taken.status()).toBe(201);

  await dialog.getByRole('button', { name: 'Dar turno' }).click();

  const alert = dialog.getByRole('alert');
  await expect(alert.getByText('Ese horario ya no está disponible')).toBeVisible();
  const next = alert.getByRole('button');
  expect(await next.count()).toBeGreaterThan(0);
  expect(await axeViolations(page)).toEqual([]);

  await next.first().click();
  await dialog.getByRole('button', { name: 'Dar turno' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Turno asignado a Gómez, Valentina/)).toBeVisible();
});
