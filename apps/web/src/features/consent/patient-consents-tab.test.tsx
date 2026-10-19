import type { ConsentListItemDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

import { PatientConsentsTab } from './PatientConsentsTab.js';
import { item, PATIENT, record, REQUEST, signingView, VERSION } from './test-fixtures.js';
import { renderHosted } from './test-host.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
type Role = 'professional' | 'reception' | 'admin' | 'owner';

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

const LIST = `GET /api/patients/${PATIENT}/consents`;

function open(
  role: Role,
  consents: ConsentListItemDto[],
  extra: Record<string, Handler | Response> = {},
  options: { readOnly?: boolean } = {},
) {
  const app = renderHosted(<PatientConsentsTab patientId={PATIENT} />, {
    me: meFor([role], options.readOnly ? { tenantStatus: 'read_only' } : {}),
    boot: bootFor('Centro Médico Aillu'),
    routes: { [LIST]: () => jsonResponse({ consents }), ...extra },
  });
  missing = app.missingKeys;
  return app;
}

describe('the consents tab: what each role reads', () => {
  it('shows reception the neutral label, the status and the dates, and no title', async () => {
    open('reception', [item({ title: null, versionNumber: null, status: 'signed' })]);

    const list = await screen.findByRole('list', { name: 'Consentimientos del paciente' });
    const entry = within(list).getByRole('listitem');
    expect(within(entry).getByText('Consentimiento')).toBeVisible();
    expect(within(entry).getByText('Firmado')).toBeVisible();
    expect(within(entry).getByText(/Solicitado el/)).toBeVisible();
    expect(within(entry).getByText(/Firmado el/)).toBeVisible();
    expect(within(entry).queryByText(/Extracción/)).not.toBeInTheDocument();
    // Reception cannot open the signed record.
    expect(screen.queryByRole('button', { name: 'Ver registro firmado' })).not.toBeInTheDocument();
  });

  it('shows the title when the server sends it (reception with the setting on), still without the record', async () => {
    open('reception', [
      item({ title: 'Extracción de muela del juicio', versionNumber: 2, canOpen: false }),
    ]);

    expect(await screen.findByText('Extracción de muela del juicio')).toBeVisible();
    expect(screen.getByText('Versión 2')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Ver registro firmado' })).not.toBeInTheDocument();
  });

  it.each([['admin'], ['owner']] as const)(
    'shows %s the label and the states, and none of the actions',
    async (role) => {
      open(role, [item({ status: 'revoked', revokedAt: '2031-03-02T12:00:00.000Z' })]);

      expect(await screen.findByText('Consentimiento')).toBeVisible();
      expect(screen.getByText('Revocado')).toBeVisible();
      expect(screen.getByText(/Revocado el/)).toBeVisible();
      for (const name of [
        'Solicitar consentimiento',
        'Registrar revocación',
        'Ver registro firmado',
      ]) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      }
    },
  );

  it('lets a treating professional open the signed record', async () => {
    const user = userEvent.setup();
    open(
      'professional',
      [item({ title: 'Extracción de muela del juicio', versionNumber: 3, canOpen: true })],
      { [`GET /api/consents/requests/${REQUEST}`]: () => jsonResponse(record()) },
    );

    await user.click(await screen.findByRole('button', { name: 'Ver registro firmado' }));

    const dialog = await screen.findByRole('dialog', { name: 'Consentimiento firmado' });
    expect(within(dialog).getByText(/Autorizo la extracción/)).toBeVisible();
    expect(within(dialog).getByText('El propio paciente')).toBeVisible();
    expect(within(dialog).getByText('Ana Pérez')).toBeVisible();
    expect(
      within(dialog).getByText(/La huella coincide: el registro no fue alterado/),
    ).toBeVisible();
  });

  it('warns when the fingerprint of a record no longer matches', async () => {
    const user = userEvent.setup();
    open('professional', [item({ canOpen: true })], {
      [`GET /api/consents/requests/${REQUEST}`]: () =>
        jsonResponse(record({ fingerprintValid: false })),
    });

    await user.click(await screen.findByRole('button', { name: 'Ver registro firmado' }));

    expect(await screen.findByText(/La huella no coincide/)).toBeVisible();
  });

  it('says there is nothing yet, and offers to ask, to who may ask', async () => {
    open('reception', []);

    expect(await screen.findByText('Este paciente no tiene consentimientos')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Solicitar consentimiento' })).toBeEnabled();
  });

  it('says there is nothing yet, and does not offer to ask, to the administration', async () => {
    open('admin', []);

    expect(await screen.findByText('Este paciente no tiene consentimientos')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Solicitar consentimiento' }),
    ).not.toBeInTheDocument();
  });

  it('shows a failed load with a way to try again', async () => {
    open('reception', [], { [LIST]: () => problemResponse(500, 'internal_error') });

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByRole('button', { name: /Reintentar/ })).toBeVisible();
  });
});

describe('the consents tab: the actions', () => {
  it('asks in person, opens the signing with the version of the request and sends the signature', async () => {
    const user = userEvent.setup();
    const signed: unknown[] = [];
    let created = false;
    open('reception', [], {
      [LIST]: () =>
        jsonResponse({ consents: created ? [item({ status: 'pending', signedAt: null })] : [] }),
      'GET /api/consent/offered-templates': () =>
        jsonResponse({
          templates: [
            {
              templateId: '0190a000-0000-7000-8000-0000000000e1',
              versionId: VERSION,
              versionNumber: 3,
              title: 'Extracción de muela del juicio',
              specialty: 'odontology',
            },
          ],
        }),
      'POST /api/consents/requests': (_url, init) => {
        created = true;
        expect(jsonBody(init)).toMatchObject({ patientId: PATIENT, method: 'in_person' });
        return jsonResponse(
          {
            request: {
              id: REQUEST,
              patientId: PATIENT,
              templateId: '0190a000-0000-7000-8000-0000000000e1',
              versionId: VERSION,
              versionNumber: 3,
              status: 'pending',
              method: 'in_person',
              createdAt: '2031-03-01T12:00:00.000Z',
              expiresAt: '2031-03-15T12:00:00.000Z',
              signedAt: null,
              revokedAt: null,
              closedAt: null,
            },
            notice: 'not_needed',
          },
          201,
        );
      },
      [`GET /api/consents/requests/${REQUEST}/signing`]: () => jsonResponse(signingView()),
      [`POST /api/consents/requests/${REQUEST}/sign`]: (_url, init) => {
        signed.push(jsonBody(init));
        return jsonResponse({
          id: REQUEST,
          patientId: PATIENT,
          templateId: '0190a000-0000-7000-8000-0000000000e1',
          versionId: VERSION,
          versionNumber: 3,
          status: 'signed',
          method: 'in_person',
          createdAt: '2031-03-01T12:00:00.000Z',
          expiresAt: '2031-03-15T12:00:00.000Z',
          signedAt: '2031-03-01T12:30:00.000Z',
          revokedAt: null,
          closedAt: null,
        });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Solicitar consentimiento' }));
    const request = await screen.findByRole('dialog', { name: 'Solicitar consentimiento' });
    await user.selectOptions(await within(request).findByLabelText('Consentimiento'), [
      'Extracción de muela del juicio',
    ]);
    await user.click(within(request).getByRole('button', { name: 'Solicitar' }));

    const signing = await screen.findByRole('dialog', { name: 'Firma del consentimiento' });
    expect(await within(signing).findByText(/Autorizo la extracción/)).toBeVisible();
    await user.click(within(signing).getByRole('button', { name: 'Escribir el nombre' }));
    await user.type(within(signing).getByLabelText('Nombre completo, como firma'), 'Ana Pérez');
    await user.click(within(signing).getByRole('checkbox', { name: /acepto este consentimiento/ }));
    await user.click(within(signing).getByRole('button', { name: 'Firmar consentimiento' }));

    await waitFor(() => {
      expect(signed).toHaveLength(1);
    });
    expect(signed[0]).toEqual({
      versionId: VERSION,
      accepted: true,
      signer: 'patient',
      mark: { kind: 'typed', name: 'Ana Pérez' },
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Firma del consentimiento' }),
      ).not.toBeInTheDocument();
    });
  });

  it('asks through the portal and says whether the patient was told', async () => {
    const user = userEvent.setup();
    open('professional', [], {
      'GET /api/consent/offered-templates': () =>
        jsonResponse({
          templates: [
            {
              templateId: '0190a000-0000-7000-8000-0000000000e1',
              versionId: VERSION,
              versionNumber: 1,
              title: 'Extracción de muela del juicio',
              specialty: null,
            },
          ],
        }),
      'POST /api/consents/requests': (_url, init) => {
        expect(jsonBody(init)).toMatchObject({ method: 'portal' });
        return jsonResponse(
          {
            request: {
              id: REQUEST,
              patientId: PATIENT,
              templateId: '0190a000-0000-7000-8000-0000000000e1',
              versionId: VERSION,
              versionNumber: 1,
              status: 'pending',
              method: 'portal',
              createdAt: '2031-03-01T12:00:00.000Z',
              expiresAt: '2031-03-15T12:00:00.000Z',
              signedAt: null,
              revokedAt: null,
              closedAt: null,
            },
            notice: 'not_sent',
          },
          201,
        );
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Solicitar consentimiento' }));
    const dialog = await screen.findByRole('dialog', { name: 'Solicitar consentimiento' });
    await user.selectOptions(await within(dialog).findByLabelText('Consentimiento'), [
      'Extracción de muela del juicio',
    ]);
    await user.click(within(dialog).getByRole('radio', { name: /Desde el portal del paciente/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Solicitar' }));

    expect(await screen.findByText(/no se pudo avisar al paciente por correo/)).toBeVisible();
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Solicitar consentimiento' }),
      ).not.toBeInTheDocument();
    });
  });

  it('records a revocation with the reason and sends only that', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open('reception', [item()], {
      [`POST /api/consents/requests/${REQUEST}/revoke`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({
          id: REQUEST,
          patientId: PATIENT,
          templateId: '0190a000-0000-7000-8000-0000000000e1',
          versionId: VERSION,
          versionNumber: 3,
          status: 'revoked',
          method: 'in_person',
          createdAt: '2031-03-01T12:00:00.000Z',
          expiresAt: '2031-03-15T12:00:00.000Z',
          signedAt: '2031-03-01T12:30:00.000Z',
          revokedAt: '2031-03-02T12:00:00.000Z',
          closedAt: null,
        });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Registrar revocación' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Registrar la revocación del consentimiento',
    });
    await user.type(within(dialog).getByLabelText('Motivo (opcional)'), 'Cambió de opinión');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar revocación' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ reason: 'Cambió de opinión' }]);
    });
  });

  it('records a revocation without a reason with an empty body', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open('professional', [item()], {
      [`POST /api/consents/requests/${REQUEST}/revoke`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return problemResponse(409, 'consent_already_revoked');
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Registrar revocación' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Registrar la revocación del consentimiento',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Registrar revocación' }));

    expect(await within(dialog).findByText('Este consentimiento ya fue revocado.')).toBeVisible();
    expect(bodies).toEqual([{}]);
  });

  it('records that the patient did not sign', async () => {
    const user = userEvent.setup();
    let calls = 0;
    open('reception', [item({ status: 'pending', signedAt: null })], {
      [`POST /api/consents/requests/${REQUEST}/decline`]: () => {
        calls += 1;
        return jsonResponse({
          id: REQUEST,
          patientId: PATIENT,
          templateId: '0190a000-0000-7000-8000-0000000000e1',
          versionId: VERSION,
          versionNumber: 3,
          status: 'declined',
          method: 'in_person',
          createdAt: '2031-03-01T12:00:00.000Z',
          expiresAt: '2031-03-15T12:00:00.000Z',
          signedAt: null,
          revokedAt: null,
          closedAt: '2031-03-01T13:00:00.000Z',
        });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'El paciente no firma' }));

    await waitFor(() => {
      expect(calls).toBe(1);
    });
  });
});

describe('the consents tab in an organization that is read-only', () => {
  it('blocks asking and signing, keeps the revocation, and says why', async () => {
    open(
      'reception',
      [
        item(),
        item({ id: '0190a000-0000-7000-8000-0000000000d2', status: 'pending', signedAt: null }),
      ],
      {},
      { readOnly: true },
    );

    await screen.findByRole('list', { name: 'Consentimientos del paciente' });
    expect(
      screen.getByText(
        /no se pueden pedir ni firmar consentimientos nuevos, pero sí registrar una revocación/,
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Solicitar consentimiento' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Firmar ahora' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Registrar revocación' })).toBeEnabled();
  });
});

describe('the consents tab: accessibility', () => {
  it('has no violations with entries, with their actions', async () => {
    const app = open('professional', [
      item({ title: 'Extracción de muela del juicio', versionNumber: 3, canOpen: true }),
      item({ id: '0190a000-0000-7000-8000-0000000000d2', status: 'pending', signedAt: null }),
    ]);

    const list = await screen.findByRole('list', { name: 'Consentimientos del paciente' });

    expect(app.container).toBeInTheDocument();
    expect(await a11yViolations(list)).toEqual([]);
  });
});
