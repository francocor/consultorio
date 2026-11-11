import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { bookableProfessional } from './support/agenda.js';
import { apiCall } from './support/clinical.js';
import {
  axeViolations,
  emailOf,
  horizontalOverflow,
  openAs,
  originOf,
  signInWithApi,
  urlOf,
} from './support/stack.js';

/**
 * Informed consent from the phone (Stage 5, track A2; spec "Consent template authoring", "Requesting
 * a consent", "Signature capture and binding", "Revocation" and "Visibility and access control"), at
 * 360 px on the real stack:
 *
 * 1. the administration writes a template from a starter and publishes it as version 1;
 * 2. reception asks a patient for it in person and the patient signs on the device, with the full
 *    text, the explicit acceptance and a typed name;
 * 3. reception sees the consent under the neutral label (no title), and the title once the
 *    organization turns on "reception sees clinical metadata"; the administration never sees it;
 * 4. the professional who treats the patient opens the signed record and its fingerprint checks;
 * 5. reception records a revocation with a reason: the consent shows revoked, and the API still
 *    refuses reception the signed record.
 *
 * Revoking from the portal in a read-only organization is proven where the pieces exist: the
 * integration test of the revocation (a read-only organization accepts it) and the portal entry point.
 * The portal itself belongs to another track, and the stack has no way to put an organization in
 * read-only mode.
 *
 * Everything the journey creates is its own (a template with a unique title, a new patient), so it
 * does not collide with the other specs. Axe and the width of the page are checked on every screen.
 */
test.use({
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
});
test.setTimeout(300_000);

const STARTER = 'Consentimiento informado para extracción dental';

/** A document number nobody else uses in this run. */
const uniqueDocument = () => `95${String(Date.now()).slice(-6)}`;

/** A confirmation toast fades in; axe reads the colors mid-fade, so let it settle first. */
async function settle(page: Page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-sonner-toast]')].every(
      (toast) => getComputedStyle(toast).opacity === '1',
    ),
  );
}

async function expectFitsAndAccessible(page: Page) {
  await settle(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

/** Turns "reception sees clinical metadata" on or off as the owner, through the API. */
async function setReceptionMetadata(page: Page, enabled: boolean) {
  await signInWithApi(page.request, 'aillu', emailOf('owner'));
  const response = await page.request.fetch(urlOf('aillu', '/api/settings'), {
    method: 'PATCH',
    headers: { origin: originOf('aillu') },
    data: { receptionSeesClinicalMetadata: enabled },
  });
  expect(response.ok(), `settings: ${await response.text()}`).toBe(true);
}

async function openConsentsTab(page: Page, patientId: string) {
  await page.goto(urlOf('aillu', `/patients/${patientId}`));
  await page.getByRole('tab', { name: 'Consentimientos' }).click();
}

test('a template is published, signed in person, read under the label rules and revoked', async ({
  page,
}) => {
  const title = `Extracción ${randomUUID().slice(0, 8)}`;

  // 1. The administration writes the template from a starter and publishes it.
  await openAs(page, 'admin', '/consents');
  await expect(page.getByRole('heading', { level: 1, name: 'Consentimientos' })).toBeVisible();
  await expectFitsAndAccessible(page);

  await page.getByRole('button', { name: 'Nueva plantilla' }).first().click();
  const editor = page.getByRole('dialog', { name: 'Nueva plantilla' });
  await editor.getByLabel('Empezar desde un ejemplo').selectOption({ label: STARTER });
  await editor.getByLabel('Título').fill(title);
  await expect(editor.getByLabel('Texto del consentimiento')).toContainText(
    'el profesional me explicó el diagnóstico',
  );
  await expectFitsAndAccessible(page);
  await editor.getByRole('button', { name: 'Guardar borrador' }).click();

  const card = page.getByRole('listitem').filter({ hasText: title });
  await expect(card.getByText('Borrador')).toBeVisible();
  await card.getByRole('button', { name: 'Publicar' }).click();
  await expect(card.getByText('Publicada')).toBeVisible();
  await expect(card.getByText(/Versión 1/)).toBeVisible();
  await expectFitsAndAccessible(page);

  // Reception does not author templates: the screen says so.
  await openAs(page, 'reception', '/consents');
  await expect(page.getByText('No tiene acceso a esta sección')).toBeVisible();

  // 2. A patient the cardiologist treats, and reception asks for the consent in person.
  const target = await bookableProfessional(page, { specialty: 'Cardiología' });
  const document = uniqueDocument();
  const patient = await apiCall<{ patient: { id: string } }>(page, 'POST', '/patients', {
    familyName: `Consentimiento${document.slice(-4)}`,
    givenNames: 'Marta',
    birthDate: '1975-04-12',
    document: { type: 'dni', number: document },
    dataProcessingConsent: true,
  });
  expect(patient.status, JSON.stringify(patient.body)).toBe(201);
  const patientId = patient.body.patient.id;
  const later = target.slots.slice(Math.floor(target.slots.length / 2));
  const offset = Math.floor(Math.random() * later.length);
  let booked = 0;
  for (const candidate of [...later.slice(offset), ...later.slice(0, offset)]) {
    const attempt = await apiCall(page, 'POST', '/appointments', {
      patientId,
      professionalId: target.professionalId,
      locationId: candidate.locationId,
      appointmentTypeId: target.typeId,
      startsAt: candidate.startsAt,
    });
    booked = attempt.status;
    if (booked === 201) break;
  }
  expect(booked).toBe(201);

  await openConsentsTab(page, patientId);
  await expect(page.getByText('Este paciente no tiene consentimientos')).toBeVisible();
  await page.getByRole('button', { name: 'Solicitar consentimiento' }).first().click();
  const request = page.getByRole('dialog', { name: 'Solicitar consentimiento' });
  await request.getByLabel('Consentimiento').selectOption({ label: title });
  await expectFitsAndAccessible(page);
  await request.getByRole('button', { name: 'Solicitar' }).click();

  const signing = page.getByRole('dialog', { name: 'Firma del consentimiento' });
  await expect(signing.getByText(/el profesional me explicó el diagnóstico/)).toBeVisible();
  await expect(signing.getByText(/Paciente: Marta Consentimiento/)).toBeVisible();

  // Without the explicit acceptance nothing is signed, and the screen says why.
  await signing.getByRole('button', { name: 'Escribir el nombre' }).click();
  await signing.getByLabel('Nombre completo, como firma').fill('Marta Paciente');
  await signing.getByRole('button', { name: 'Firmar consentimiento' }).click();
  await expect(
    signing.getByText('Para firmar hay que aceptar el texto del consentimiento.'),
  ).toBeVisible();
  await expectFitsAndAccessible(page);

  await signing.getByRole('checkbox', { name: /acepto este consentimiento/ }).click();
  await signing.getByRole('button', { name: 'Firmar consentimiento' }).click();
  await expect(page.getByText('El consentimiento quedó firmado.')).toBeVisible();

  // 3. Reception reads the label, not the title; and the title once the setting is on.
  const entry = page
    .getByRole('list', { name: 'Consentimientos del paciente' })
    .getByRole('listitem');
  await expect(entry.getByText('Consentimiento', { exact: true })).toBeVisible();
  await expect(entry.getByText('Firmado', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Consentimientos del paciente' })).not.toContainText(
    title,
  );
  await expect(page.getByRole('button', { name: 'Ver registro firmado' })).toHaveCount(0);
  await expectFitsAndAccessible(page);

  const listed = await apiCall<{ consents: { id: string }[] }>(
    page,
    'GET',
    `/patients/${patientId}/consents`,
  );
  const requestId = listed.body.consents[0]?.id ?? '';
  expect(requestId).not.toBe('');
  // The API keeps the signed record from reception whatever the screen shows.
  expect((await apiCall(page, 'GET', `/consents/requests/${requestId}`)).status).toBe(403);

  await setReceptionMetadata(page, true);
  try {
    await openAs(page, 'reception', `/patients/${patientId}`);
    await page.getByRole('tab', { name: 'Consentimientos' }).click();
    await expect(page.getByRole('list', { name: 'Consentimientos del paciente' })).toContainText(
      title,
    );
    await expect(page.getByRole('button', { name: 'Ver registro firmado' })).toHaveCount(0);
    await expectFitsAndAccessible(page);

    // The administration never sees the title, with the setting on.
    await openAs(page, 'admin', `/patients/${patientId}`);
    await page.getByRole('tab', { name: 'Consentimientos' }).click();
    const adminList = page.getByRole('list', { name: 'Consentimientos del paciente' });
    await expect(adminList.getByText('Consentimiento', { exact: true })).toBeVisible();
    await expect(adminList).not.toContainText(title);
    await expect(page.getByRole('button', { name: 'Solicitar consentimiento' })).toHaveCount(0);
    await expectFitsAndAccessible(page);
  } finally {
    await setReceptionMetadata(page, false);
  }

  // 4. The cardiologist who treats the patient opens the signed record.
  await openAs(page, 'cardiology', `/patients/${patientId}`);
  await page.getByRole('tab', { name: 'Consentimientos' }).click();
  await expect(page.getByRole('list', { name: 'Consentimientos del paciente' })).toContainText(
    title,
  );
  await page.getByRole('button', { name: 'Ver registro firmado' }).click();
  const record = page.getByRole('dialog', { name: 'Consentimiento firmado' });
  await expect(record.getByText(/el profesional me explicó el diagnóstico/)).toBeVisible();
  await expect(record.getByText('Marta Paciente')).toBeVisible();
  await expect(record.getByText(/La huella coincide/)).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.keyboard.press('Escape');

  // 5. Reception records a revocation asked for in person.
  await openAs(page, 'reception', `/patients/${patientId}`);
  await page.getByRole('tab', { name: 'Consentimientos' }).click();
  await page.getByRole('button', { name: 'Registrar revocación' }).click();
  const revoke = page.getByRole('dialog', { name: 'Registrar la revocación del consentimiento' });
  await revoke.getByLabel('Motivo (opcional)').fill('La paciente cambió de opinión');
  await expectFitsAndAccessible(page);
  await revoke.getByRole('button', { name: 'Registrar revocación' }).click();
  await expect(page.getByText('La revocación quedó registrada.')).toBeVisible();
  const revoked = page
    .getByRole('list', { name: 'Consentimientos del paciente' })
    .getByRole('listitem');
  await expect(revoked.getByText('Revocado', { exact: true })).toBeVisible();
  await expect(revoked.getByText(/Revocado el/)).toBeVisible();
  await expect(revoked.getByRole('button', { name: 'Registrar revocación' })).toHaveCount(0);
  await expectFitsAndAccessible(page);

  // The professional still reads the signed original, now with the revocation beside it.
  await openAs(page, 'cardiology', `/patients/${patientId}`);
  await page.getByRole('tab', { name: 'Consentimientos' }).click();
  await page.getByRole('button', { name: 'Ver registro firmado' }).click();
  const after = page.getByRole('dialog', { name: 'Consentimiento firmado' });
  await expect(after.getByText(/Revocado el/)).toBeVisible();
  await expect(after.getByText(/Motivo: La paciente cambió de opinión/)).toBeVisible();
  await expect(after.getByText(/La huella coincide/)).toBeVisible();
});
