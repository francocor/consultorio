import { expect, test, type Page } from '@playwright/test';

import { bookableProfessional, clockTime } from './support/agenda.js';
import { axeViolations, openAs, urlOf } from './support/stack.js';

/**
 * A whole visit, end to end (SCH-11): reception books, confirms and checks the patient in; the
 * professional starts and finishes the consultation. Each person works on their own session, and
 * the drawer shows only what can be done next. Axe runs with the drawer open at each step.
 */
// Toasts fade in; axe would read the colors of a half-transparent message.
test.use({ reducedMotion: 'reduce' });

async function openAppointment(page: Page, name: RegExp) {
  await page.getByRole('button', { name }).first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('link', { name: 'Ver ficha del paciente' })).toBeVisible();
  return drawer;
}

test('book, confirm, check in, start and attend', async ({ page, browser }) => {
  await openAs(page, 'reception', '/');
  const target = await bookableProfessional(page);
  const slot = target.slots[0];
  if (!slot) throw new Error('The demo professional has no free time in the next four weeks');
  const when = clockTime(slot.startsAt);
  const agenda = `/calendar?date=${slot.date}&pros=${target.professionalId}`;

  // Reception books an existing patient.
  await page.goto(urlOf('aillu', agenda));
  await page.getByRole('button', { name: 'Nuevo turno' }).click();
  const booking = page.getByRole('dialog', { name: 'Nuevo turno' });
  await booking
    .getByRole('group', { name: 'Horarios disponibles' })
    .getByRole('button', { name: when, exact: true })
    .click();
  await booking.getByRole('combobox', { name: 'Paciente' }).fill('Gómez');
  await booking.getByRole('option', { name: /Gómez, Valentina/ }).click();
  await booking.getByRole('button', { name: 'Dar turno' }).click();
  await expect(booking).toBeHidden();

  // Confirm it. Only the actions that apply are offered.
  const card = new RegExp(`${when}.*Gómez, Valentina.*Programado`);
  let drawer = await openAppointment(page, card);
  await expect(drawer.getByText('Programado', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Iniciar consulta' })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
  await drawer.getByRole('button', { name: 'Confirmar turno' }).click();
  await expect(drawer.getByText('Confirmado', { exact: true })).toBeVisible();

  // The patient arrives.
  await drawer.getByRole('button', { name: 'Registrar llegada' }).click();
  await expect(drawer.getByText('En sala', { exact: true })).toBeVisible();
  const history = drawer.getByRole('list', { name: 'Historial del turno' });
  await expect(history.getByText('Pasó de Confirmado a En sala')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The professional starts and finishes the consultation in their own session.
  const professional = await (await browser.newContext()).newPage();
  await openAs(professional, 'cardiology', agenda);
  const theirs = await openAppointment(
    professional,
    new RegExp(`${when}.*Gómez, Valentina.*En sala`),
  );
  await expect(theirs.getByRole('button', { name: 'Reprogramar' })).toHaveCount(0);
  await theirs.getByRole('button', { name: 'Iniciar consulta' }).click();
  // Calling the patient in leads to a new encounter tied to this appointment (D20); the visit is
  // now in progress and the agenda offers the same way in as a link.
  await expect(professional).toHaveURL(/\/encounters\/new\?.*appointmentId=/);
  await expect(professional.getByText(/^Turno: /)).toBeVisible();
  await professional.goto(urlOf('aillu', agenda));
  const running = await openAppointment(
    professional,
    new RegExp(`${when}.*Gómez, Valentina.*En consulta`),
  );
  await expect(running.getByRole('link', { name: 'Iniciar consulta' })).toBeVisible();
  await running.getByRole('button', { name: 'Finalizar consulta' }).click();
  await expect(running.getByText('Atendido', { exact: true })).toBeVisible();
  expect(await axeViolations(professional)).toEqual([]);
  // A finished visit offers only the correction.
  await expect(running.getByRole('button', { name: 'Corregir estado' })).toBeVisible();
  await expect(running.getByRole('button', { name: 'Cancelar turno' })).toHaveCount(0);

  // Reception sees the result on a fresh load of the same agenda.
  await page.goto(urlOf('aillu', agenda));
  drawer = await openAppointment(page, new RegExp(`${when}.*Gómez, Valentina.*Atendido`));
  await expect(drawer.getByText('Atendido', { exact: true })).toBeVisible();

  // The professional marked it by mistake: a correction takes a reason code and the version.
  await running.getByRole('button', { name: 'Corregir estado' }).click();
  const correction = running.getByRole('group', { name: 'Corregir el estado' });
  await correction.getByLabel('Nuevo estado').selectOption({ label: 'Ausente' });
  await expect(correction.getByRole('button', { name: 'Corregir el estado' })).toBeDisabled();
  await correction
    .getByLabel('Motivo de la corrección')
    .selectOption({ label: 'Se marcó por error' });
  await correction.getByLabel('Detalle (opcional)').fill('Se abrió el turno equivocado');
  await correction.getByRole('button', { name: 'Corregir el estado' }).click();
  await expect(running.getByText('Ausente', { exact: true })).toBeVisible();
  expect(await axeViolations(professional)).toEqual([]);
});
