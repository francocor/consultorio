import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse } from '../../shared/test/render.js';

import { PATIENT_IDS, patient, summary } from './fixtures.js';

type Handler = (url: string, init: RequestInit) => Response;

function open(routes: Record<string, Handler> = {}, me = meFor(['reception'])) {
  return renderApp({
    me,
    path: '/patients/new',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      [`GET /api/patients/${PATIENT_IDS.valentina}`]: () => jsonResponse(patient()),
      ...routes,
    },
  });
}

type User = ReturnType<typeof userEvent.setup>;

async function fillBasics(user: User, overrides: { birthDate?: string; document?: string } = {}) {
  await user.type(await screen.findByLabelText('Apellido'), 'Gómez');
  await user.type(screen.getByLabelText('Nombre'), 'Valentina');
  await user.type(
    screen.getByLabelText('Fecha de nacimiento'),
    overrides.birthDate ?? '1988-05-04',
  );
  if (overrides.document !== undefined) {
    await user.type(screen.getByLabelText('Número de documento'), overrides.document);
  }
}

describe('new patient form', () => {
  it('registers the patient and opens their record', async () => {
    const user = userEvent.setup();
    let body: unknown;
    const app = open({
      'POST /api/patients': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ patient: patient(), possibleDuplicates: [] }, 201);
      },
    });
    await fillBasics(user, { document: '30.123.456' });
    await user.click(screen.getByRole('radio', { name: /El paciente acepta/ }));
    await user.click(screen.getByRole('button', { name: 'Registrar paciente' }));

    await waitFor(() => {
      expect(body).toEqual({
        familyName: 'Gómez',
        givenNames: 'Valentina',
        birthDate: '1988-05-04',
        document: { type: 'dni', number: '30.123.456' },
        dataProcessingConsent: true,
      });
    });
    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe(`/patients/${PATIENT_IDS.valentina}`);
    });
    expect(app.missingKeys).toEqual([]);
  });

  it('shows what is missing next to each field and sends nothing', async () => {
    const user = userEvent.setup();
    const app = open();
    await screen.findByRole('heading', { level: 1, name: 'Nuevo paciente' });

    await user.click(screen.getByRole('button', { name: 'Registrar paciente' }));

    expect(await screen.findAllByText('Este dato es obligatorio.')).not.toHaveLength(0);
    expect(screen.getByText('Responda esta pregunta para continuar.')).toBeInTheDocument();
    expect(app.requests).not.toContain('POST /api/patients');
  });

  it('checks the document with the rules of the country', async () => {
    const user = userEvent.setup();
    const app = open();
    await fillBasics(user, { document: '12' });
    await user.click(screen.getByRole('radio', { name: /El paciente acepta/ }));

    await user.click(screen.getByRole('button', { name: 'Registrar paciente' }));

    expect(await screen.findByText(/El DNI no es válido/)).toBeInTheDocument();
    expect(app.requests).not.toContain('POST /api/patients');
  });

  it('lets a patient have no document, and then the number is not asked', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> = {};
    open({
      'POST /api/patients': (_url, init) => {
        body = jsonBody(init) as Record<string, unknown>;
        return jsonResponse(
          { patient: patient({ document: null, noDocument: true }), possibleDuplicates: [] },
          201,
        );
      },
    });
    await fillBasics(user);

    await user.selectOptions(screen.getByLabelText('Documento'), 'none');
    expect(screen.queryByLabelText('Número de documento')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Un recién nacido o una persona sin documento puede registrarse igual/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /todavía no lo acepta/ }));
    await user.click(screen.getByRole('button', { name: 'Registrar paciente' }));

    await waitFor(() => {
      expect(body['document']).toBeNull();
    });
    expect(body['dataProcessingConsent']).toBe(false);
  });

  it('asks for a representative when the patient is a minor', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> = {};
    open({
      'POST /api/patients': (_url, init) => {
        body = jsonBody(init) as Record<string, unknown>;
        return jsonResponse({ patient: patient(), possibleDuplicates: [] }, 201);
      },
    });
    const year = String(new Date().getFullYear() - 6);
    await fillBasics(user, { birthDate: `${year}-03-10` });
    await user.selectOptions(screen.getByLabelText('Documento'), 'none');

    expect(await screen.findByText(/Es menor de 18 años/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /El paciente acepta/ }));
    await user.click(screen.getByRole('button', { name: 'Registrar paciente' }));
    expect(
      await screen.findByText('Cargue un teléfono o un correo del representante.'),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('Nombre completo del representante'), 'Lorena Gómez');
    await user.selectOptions(screen.getByLabelText('Vínculo'), 'mother');
    await user.type(screen.getByLabelText('Teléfono del representante'), '11 6666 0000');
    await user.click(screen.getByRole('button', { name: 'Registrar paciente' }));

    await waitFor(() => {
      expect(body['representative']).toEqual({
        fullName: 'Lorena Gómez',
        relation: 'mother',
        phone: '11 6666 0000',
      });
    });
  });

  it('an adult does not see the representative section', async () => {
    const user = userEvent.setup();
    open();
    await fillBasics(user);

    expect(screen.queryByLabelText('Nombre completo del representante')).not.toBeInTheDocument();
  });

  it('blocks a duplicate document and offers the existing record, keeping what was typed', async () => {
    const user = userEvent.setup();
    open({
      'POST /api/patients': () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            code: 'conflict',
            i18nKey: 'errors.conflict',
            requestId: 'r1',
            existingPatient: summary({ familyName: 'Gómez', givenNames: 'Valentina' }),
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    await fillBasics(user, { document: '99000001' });
    await user.click(screen.getByRole('radio', { name: /El paciente acepta/ }));
    await user.click(screen.getByRole('button', { name: 'Registrar paciente' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Ese documento ya está registrado')).toBeInTheDocument();
    expect(within(alert).getByText('Gómez, Valentina')).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'Abrir la ficha' })).toHaveAttribute(
      'href',
      `/patients/${PATIENT_IDS.valentina}`,
    );
    expect(screen.getByLabelText('Apellido')).toHaveValue('Gómez');
  });

  it('warns about possible duplicates after saving a patient without a document, without blocking', async () => {
    const user = userEvent.setup();
    open({
      'POST /api/patients': () =>
        jsonResponse(
          {
            patient: patient({ document: null, noDocument: true }),
            possibleDuplicates: [
              summary({ id: PATIENT_IDS.santiago, familyName: 'Gómez', givenNames: 'Valentina' }),
            ],
          },
          201,
        ),
    });
    await fillBasics(user);
    await user.selectOptions(screen.getByLabelText('Documento'), 'none');
    await user.click(screen.getByRole('radio', { name: /El paciente acepta/ }));
    await user.click(screen.getByRole('button', { name: 'Registrar paciente' }));

    expect(
      await screen.findByText('El paciente quedó registrado, pero puede estar repetido'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Abrir Gómez, Valentina' })).toHaveAttribute(
      'href',
      `/patients/${PATIENT_IDS.santiago}`,
    );
    expect(screen.getByRole('link', { name: 'Abrir la ficha nueva' })).toHaveAttribute(
      'href',
      `/patients/${PATIENT_IDS.valentina}`,
    );
  });

  it('has no accessibility violations', async () => {
    const app = open();
    await screen.findByRole('heading', { level: 1, name: 'Nuevo paciente' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
