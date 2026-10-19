import type { PrescriptionCapabilityDto, PrescriptionDto } from '@consultorio/contracts';
import { createRoute } from '@tanstack/react-router';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { createRegistry, type FeatureRoute } from '../../app/registry.js';
import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../shared/test/render.js';

import { PatientPrescriptionsTab } from './PatientPrescriptionsTab.js';
import {
  OTHER_PROFESSIONAL,
  PATIENT,
  capability,
  prescription,
  refused,
  waiting,
} from './test-fixtures.js';

/**
 * The prescriptions of a patient, in the record (S5.05, tasks 5.21 and 5.22; e-prescription,
 * "Issuing and status lifecycle", "Provider outage handling", "Immutability and cancellation"): every
 * state the provider can leave a prescription in is told in words, a prescription the provider has not
 * confirmed is never shown as valid, and the form validates each field in Spanish.
 */

type Missing = string[] | undefined;
let missing: Missing;

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

interface Setup {
  roles?: Parameters<typeof meFor>[0];
  prescriptions?: PrescriptionDto[];
  capabilityOverrides?: Partial<PrescriptionCapabilityDto>;
  boot?: ReturnType<typeof bootFor>;
  routes?: Record<string, FetchHandler | Response>;
}

/** The tab, mounted where the patient record mounts it: inside the signed-in shell. */
const hostRoute: FeatureRoute = {
  mount: 'authed',
  create: (parent) =>
    createRoute({
      getParentRoute: () => parent,
      path: '/fixture-host',
      component: () => <PatientPrescriptionsTab patientId={PATIENT} />,
    }),
};

function open({
  roles = ['professional'],
  prescriptions = [],
  capabilityOverrides = {},
  boot = bootFor('Centro Médico Aillu'),
  routes = {},
}: Setup = {}) {
  const app = renderApp({
    me: meFor(roles),
    boot,
    path: '/fixture-host',
    registry: createRegistry({
      routes: { '../features/host/routes.tsx': { default: [hostRoute] } },
      nav: {},
      slots: {},
    }),
    routes: {
      'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
      'GET /api/prescriptions/capability': () => jsonResponse(capability(capabilityOverrides)),
      [`GET /api/patients/${PATIENT}/prescriptions`]: () => jsonResponse({ prescriptions }),
      'GET /api/prescriptions/catalog': (url) => {
        const q = new URL(url, 'http://localhost').searchParams.get('q') ?? '';
        return jsonResponse({
          names: q.toLowerCase().startsWith('amox')
            ? ['Amoxicilina', 'Amoxicilina con ácido clavulánico']
            : [],
        });
      },
      ...routes,
    },
  });
  missing = app.missingKeys;
  return app;
}

const problemWithFields = (
  status: number,
  code: string,
  errors: { path: string; i18nKey: string }[],
) =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: code,
      status,
      code,
      i18nKey: `errors.${code}`,
      requestId: 'req-test',
      errors,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

describe('the states of a prescription', () => {
  it('shows an issued prescription with its identifier, its medication and the actions of its prescriber', async () => {
    open({ prescriptions: [prescription()] });

    const card = await screen.findByRole('article', { name: 'Receta del 19/10/2026' });
    expect(within(card).getByText('Emitida')).toBeInTheDocument();
    expect(
      within(card).getByText('Amoxicilina 500 mg, comprimidos, cantidad 21'),
    ).toBeInTheDocument();
    expect(within(card).getByText('1 cada 8 horas durante 7 días')).toBeInTheDocument();
    expect(within(card).getByText('ERX-0123456789AB')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Descargar PDF' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Anular' })).toBeInTheDocument();
    expect(
      within(card).queryByRole('button', { name: 'Reintentar ahora' }),
    ).not.toBeInTheDocument();
  });

  it('never calls a prescription the provider has not confirmed "emitida": it is pending, not valid, and offers to retry, register by hand or cancel', async () => {
    open({ prescriptions: [waiting()] });

    const card = await screen.findByRole('article');
    expect(within(card).getByText('Pendiente de envío')).toBeInTheDocument();
    expect(within(card).queryByText('Emitida')).not.toBeInTheDocument();
    expect(within(card).getByText('El proveedor todavía no la confirmó')).toBeInTheDocument();
    expect(
      within(card).getByText(/no es válida hasta que el proveedor la confirme/),
    ).toBeInTheDocument();
    expect(within(card).getByText(/Próximo intento: 19\/10\/2026/)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Descargar PDF' })).not.toBeInTheDocument();
    for (const name of ['Reintentar ahora', 'Registrar a mano', 'Anular']) {
      expect(within(card).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('warns that the provider may have issued it already when the answer was lost, and does not offer to cancel or register it', async () => {
    open({ prescriptions: [waiting({ awaitingReconciliation: true })] });

    const card = await screen.findByRole('article');
    expect(within(card).getByText(/ya la haya emitido/)).toBeInTheDocument();
    expect(
      within(card).queryByRole('button', { name: 'Registrar a mano' }),
    ).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Anular' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Reintentar ahora' })).toBeInTheDocument();
  });

  it('tells what a person has to do when the prescription cannot be sent by itself', async () => {
    open({ prescriptions: [waiting({ kind: 'needs_attention', nextAttemptAt: null })] });

    const card = await screen.findByRole('article');
    expect(within(card).getByText('Requiere atención')).toBeInTheDocument();
    expect(within(card).getByText('No se puede enviar sola')).toBeInTheDocument();
  });

  it('shows the words of the provider about a refusal and offers to correct and resend', async () => {
    open({ prescriptions: [refused()] });

    const card = await screen.findByRole('article');
    expect(within(card).getByText('Rechazada')).toBeInTheDocument();
    expect(
      within(card).getByText(/no empieza con un nombre genérico del catálogo/),
    ).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Corregir y reenviar' })).toBeInTheDocument();
  });

  it('keeps a cancelled prescription visible with its reason, and a dispensed one without actions', async () => {
    open({
      prescriptions: [
        prescription({
          id: '0190a000-0000-7000-8000-0000000000e1',
          status: 'cancelled',
          cancelReason: 'Error en la dosis',
          cancelledAt: '2026-10-19T16:00:00.000Z',
        }),
        prescription({
          id: '0190a000-0000-7000-8000-0000000000e2',
          status: 'dispensed',
          documentAvailable: false,
        }),
      ],
    });

    const [cancelled, dispensed] = await screen.findAllByRole('article');
    expect(within(cancelled as HTMLElement).getByText('Anulada')).toBeInTheDocument();
    expect(within(cancelled as HTMLElement).getByText(/Error en la dosis/)).toBeInTheDocument();
    expect(
      within(cancelled as HTMLElement).queryByRole('button', { name: 'Anular' }),
    ).not.toBeInTheDocument();
    expect(within(dispensed as HTMLElement).getByText('Dispensada')).toBeInTheDocument();
    expect(within(dispensed as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
  });

  it('lets a colleague who treats the patient read it and download it, and names the prescriber', async () => {
    open({
      prescriptions: [
        prescription({
          prescriber: {
            professionalId: OTHER_PROFESSIONAL,
            fullName: 'Dr. Luis Díaz',
            matricula: 'MP 999',
            jurisdiction: 'AR-B',
            specialty: null,
          },
        }),
      ],
    });

    const card = await screen.findByRole('article');
    expect(within(card).getByText('Dr. Luis Díaz')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Descargar PDF' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Anular' })).not.toBeInTheDocument();
  });

  it('says a prescription is simulated, on the screen and on the prescription', async () => {
    open({
      prescriptions: [prescription({ simulated: true })],
      boot: bootFor('Centro Médico Aillu', { localProviders: { afip: false, erx: true } }),
    });

    expect(await screen.findByText('Recetas de prueba')).toBeInTheDocument();
    expect(screen.getByText('Simulada')).toBeInTheDocument();
  });

  it('shows the empty state when the patient has no prescriptions yet', async () => {
    open();

    expect(await screen.findByText('Todavía no hay recetas')).toBeInTheDocument();
  });

  it('passes the accessibility checks with every state on screen', async () => {
    const app = open({
      prescriptions: [prescription(), waiting(), refused()],
      boot: bootFor('Centro Médico Aillu', { localProviders: { afip: false, erx: true } }),
    });
    await screen.findAllByRole('article');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('when the form cannot be used', () => {
  it('says the provider is not connected, sends the owner to the settings and disables the button', async () => {
    open({
      roles: ['owner', 'professional'],
      capabilityOverrides: { enabled: false, canIssue: false },
    });

    expect(await screen.findByText('La receta electrónica no está conectada')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Ir a la configuración de recetas electrónicas' }),
    ).toHaveAttribute('href', '/settings/prescriptions');
    const button = screen.getByRole('button', { name: 'Emitir receta' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/La receta electrónica no está conectada/);
  });

  it('tells a professional who cannot change the settings to ask the owner', async () => {
    open({ capabilityOverrides: { enabled: false, canIssue: false } });

    expect(await screen.findByText(/Pida al titular o a un administrador/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /configuración/ })).not.toBeInTheDocument();
  });

  it('says there is no provider at all when the deployment serves none', async () => {
    open({ capabilityOverrides: { providerAvailable: false, enabled: false, canIssue: false } });

    expect(
      await screen.findByText(/no tiene un proveedor de recetas configurado/),
    ).toBeInTheDocument();
  });

  it('explains that the matricula has to be verified by the platform, and that the rest of the work is not affected', async () => {
    open({ capabilityOverrides: { matriculaStatus: 'unverified', canIssue: false } });

    expect(await screen.findByText('Su matrícula todavía no está verificada')).toBeInTheDocument();
    expect(screen.getByText(/el resto de su trabajo clínico no cambia/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Emitir receta' })).toBeDisabled();
  });

  it('asks to complete the matricula when there is none', async () => {
    open({ capabilityOverrides: { matriculaStatus: 'missing', canIssue: false } });

    expect(await screen.findByText(/Complete la matrícula y la jurisdicción/)).toBeInTheDocument();
  });
});

describe('issuing a prescription', () => {
  const fillMedication = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText('Dosis'), '500 mg');
    await user.type(screen.getByLabelText('Forma farmacéutica'), 'comprimidos');
    await user.type(screen.getByLabelText('Cantidad'), '21');
    await user.type(screen.getByLabelText('Indicaciones'), '1 cada 8 horas durante 7 días');
  };

  it('points at every missing field in Spanish, and sends nothing', async () => {
    const user = userEvent.setup();
    open({ routes: { 'POST /api/prescriptions': () => jsonResponse(prescription(), 201) } });
    await user.click(await screen.findByRole('button', { name: 'Emitir receta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Emitir receta' });

    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));

    expect(within(dialog).getAllByText('Este dato es obligatorio.')).toHaveLength(4);
    expect(within(dialog).getByText('Ingrese una cantidad entera de 1 a 999.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Cantidad')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByLabelText('Cantidad')).toHaveAccessibleDescription(
      'Ingrese una cantidad entera de 1 a 999.',
    );
  });

  it('refuses a quantity that is not a whole number and accepts one after it is fixed', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Emitir receta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Emitir receta' });
    await user.type(within(dialog).getByLabelText('Nombre genérico'), 'Ibuprofeno');
    await fillMedication(user);
    await user.clear(within(dialog).getByLabelText('Cantidad'));
    await user.type(within(dialog).getByLabelText('Cantidad'), '2,5');

    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));
    expect(within(dialog).getByText('Ingrese una cantidad entera de 1 a 999.')).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText('Cantidad'));
    await user.type(within(dialog).getByLabelText('Cantidad'), '12');
    await waitFor(() => {
      expect(
        within(dialog).queryByText('Ingrese una cantidad entera de 1 a 999.'),
      ).not.toBeInTheDocument();
    });
  });

  it('suggests generic names while typing, takes one with the keyboard, and sends the prescription', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'POST /api/prescriptions': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(prescription(), 201);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Emitir receta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Emitir receta' });

    const field = within(dialog).getByRole('combobox', { name: 'Nombre genérico' });
    await user.type(field, 'amox');
    const list = await screen.findByRole('listbox', { name: 'Nombres genéricos sugeridos' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Amoxicilina', 'Amoxicilina con ácido clavulánico']);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(field).toHaveValue('Amoxicilina');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await fillMedication(user);
    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    const { clientKey, ...sent } = bodies[0] as { clientKey: string };
    expect(clientKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent).toEqual({
      patientId: PATIENT,
      items: [
        {
          genericName: 'Amoxicilina',
          dose: '500 mg',
          form: 'comprimidos',
          quantity: 21,
          instructions: '1 cada 8 horas durante 7 días',
        },
      ],
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('keeps what was typed when no suggestion is taken: the provider knows its catalog', async () => {
    const user = userEvent.setup();
    const bodies: { items: { genericName: string }[] }[] = [];
    open({
      routes: {
        'POST /api/prescriptions': (_url, init) => {
          bodies.push(jsonBody(init) as { items: { genericName: string }[] });
          return jsonResponse(prescription(), 201);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Emitir receta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Emitir receta' });
    await user.type(
      within(dialog).getByRole('combobox', { name: 'Nombre genérico' }),
      'Principio raro',
    );
    await fillMedication(user);

    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));

    await waitFor(() => {
      expect(bodies[0]?.items[0]?.genericName).toBe('Principio raro');
    });
  });

  it('sends the same key when the same prescription is sent again after a failure, and another when it changes', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    let calls = 0;
    open({
      routes: {
        'POST /api/prescriptions': (_url, init) => {
          calls += 1;
          keys.push((jsonBody(init) as { clientKey: string }).clientKey);
          return calls < 3
            ? problemResponse(503, 'service_unavailable')
            : jsonResponse(prescription(), 201);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Emitir receta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Emitir receta' });
    await user.type(
      within(dialog).getByRole('combobox', { name: 'Nombre genérico' }),
      'Ibuprofeno',
    );
    await fillMedication(user);

    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));
    await waitFor(() => {
      expect(calls).toBe(1);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));
    await waitFor(() => {
      expect(calls).toBe(2);
    });
    await user.type(within(dialog).getByLabelText('Indicaciones'), ' con comida');
    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));
    await waitFor(() => {
      expect(calls).toBe(3);
    });

    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('shows the refusal of the server next to the field it is about', async () => {
    const user = userEvent.setup();
    open({
      routes: {
        'POST /api/prescriptions': () =>
          problemWithFields(400, 'validation_failed', [
            { path: 'items.0.quantity', i18nKey: 'validation.too_big' },
          ]),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Emitir receta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Emitir receta' });
    await user.type(
      within(dialog).getByRole('combobox', { name: 'Nombre genérico' }),
      'Ibuprofeno',
    );
    await fillMedication(user);

    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));

    expect(
      await within(dialog).findByText('El valor ingresado es demasiado alto.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Cantidad')).toHaveAttribute('aria-invalid', 'true');
  });

  it('explains a refusal that is not about a field, such as a patient without a document', async () => {
    const user = userEvent.setup();
    open({
      routes: {
        'POST /api/prescriptions': () =>
          problemResponse(422, 'prescription_patient_document_required'),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Emitir receta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Emitir receta' });
    await user.type(
      within(dialog).getByRole('combobox', { name: 'Nombre genérico' }),
      'Ibuprofeno',
    );
    await fillMedication(user);

    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'El paciente no tiene documento cargado',
    );
  });

  it('adds and removes medications, up to the limit', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Emitir receta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Emitir receta' });

    await user.click(within(dialog).getByRole('button', { name: 'Agregar otro medicamento' }));
    expect(within(dialog).getAllByRole('group')).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: 'Quitar el medicamento 2' }));

    expect(within(dialog).getAllByRole('group')).toHaveLength(1);
    expect(
      within(dialog).queryByRole('button', { name: /Quitar el medicamento/ }),
    ).not.toBeInTheDocument();
  });

  it('tells the person the prescription is pending when the provider did not answer', async () => {
    const user = userEvent.setup();
    open({
      routes: { 'POST /api/prescriptions': () => jsonResponse(waiting(), 201) },
    });
    await user.click(await screen.findByRole('button', { name: 'Emitir receta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Emitir receta' });
    await user.type(
      within(dialog).getByRole('combobox', { name: 'Nombre genérico' }),
      'Ibuprofeno',
    );
    await fillMedication(user);

    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));

    expect(
      await screen.findByText(/quedó pendiente y no es válida hasta que lo confirme/),
    ).toBeInTheDocument();
  });

  it('passes the accessibility checks with the form open', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Emitir receta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Emitir receta' });
    await user.click(within(dialog).getByRole('button', { name: 'Emitir receta' }));

    expect(await a11yViolations(dialog)).toEqual([]);
  });
});

const TOKEN = 'a'.repeat(43);

describe('what the prescriber does with a prescription', () => {
  it('retries a pending prescription and shows it issued', async () => {
    const user = userEvent.setup();
    let calls = 0;
    open({
      prescriptions: [waiting()],
      routes: {
        'POST /api/prescriptions/0190a000-0000-7000-8000-0000000000d2/retry': () => {
          calls += 1;
          return jsonResponse(prescription({ id: '0190a000-0000-7000-8000-0000000000d2' }));
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Reintentar ahora' }));

    await waitFor(() => {
      expect(calls).toBe(1);
    });
    expect(await screen.findByText('Receta emitida.')).toBeInTheDocument();
  });

  it('asks for a reason before it cancels, sends it, and says when the provider refused', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      prescriptions: [prescription()],
      routes: {
        'POST /api/prescriptions/0190a000-0000-7000-8000-0000000000d1/cancel': (_url, init) => {
          bodies.push(jsonBody(init));
          return problemResponse(409, 'prescription_cancel_refused');
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Anular' }));
    const dialog = await screen.findByRole('dialog', { name: 'Anular receta' });
    const submit = within(dialog).getByRole('button', { name: 'Anular receta' });
    expect(submit).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Motivo de la anulación'), 'Error en la dosis');
    await user.click(submit);

    await waitFor(() => {
      expect(bodies).toEqual([{ reason: 'Error en la dosis' }]);
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'El proveedor rechazó la anulación. La receta sigue emitida.',
    );
  });

  it('explains that a prescription the provider never confirmed is cancelled here', async () => {
    const user = userEvent.setup();
    open({ prescriptions: [waiting()] });

    await user.click(await screen.findByRole('button', { name: 'Anular' }));
    const dialog = await screen.findByRole('dialog', { name: 'Anular receta' });

    expect(within(dialog).getByText(/se anula aquí sin consultarlo/)).toBeInTheDocument();
  });

  it('registers the identifier of a prescription issued on the site of the provider', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      prescriptions: [waiting()],
      routes: {
        'POST /api/prescriptions/0190a000-0000-7000-8000-0000000000d2/register-manual': (
          _url,
          init,
        ) => {
          bodies.push(jsonBody(init));
          return jsonResponse(
            prescription({
              id: '0190a000-0000-7000-8000-0000000000d2',
              registeredManually: true,
              externalId: 'RX-SITIO-1',
            }),
          );
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Registrar a mano' }));
    const dialog = await screen.findByRole('dialog', { name: 'Registrar a mano' });

    await user.type(within(dialog).getByLabelText('Identificador de la receta'), 'RX-SITIO-1');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ identifier: 'RX-SITIO-1' }]);
    });
    expect(await screen.findByText('Receta registrada.')).toBeInTheDocument();
  });

  it('corrects a refused prescription with the medications already in the form, and sends it again', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      prescriptions: [refused()],
      routes: {
        'PUT /api/prescriptions/0190a000-0000-7000-8000-0000000000d3': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(prescription({ id: '0190a000-0000-7000-8000-0000000000d3' }));
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Corregir y reenviar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Corregir receta' });
    expect(within(dialog).getByRole('combobox', { name: 'Nombre genérico' })).toHaveValue(
      'Amoxicilina',
    );
    await user.clear(within(dialog).getByLabelText('Cantidad'));
    await user.type(within(dialog).getByLabelText('Cantidad'), '14');

    await user.click(within(dialog).getByRole('button', { name: 'Corregir y reenviar' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          items: [
            {
              genericName: 'Amoxicilina',
              dose: '500 mg',
              form: 'comprimidos',
              quantity: 14,
              instructions: '1 cada 8 horas durante 7 días',
            },
          ],
        },
      ]);
    });
  });

  it('asks for a link and follows it with the session to download the PDF', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      prescriptions: [prescription()],
      routes: {
        'POST /api/prescriptions/0190a000-0000-7000-8000-0000000000d1/document-link': () => {
          calls.push('link');
          return jsonResponse({ url: `/files/${TOKEN}`, expiresAt: '2026-10-19T15:05:00.000Z' });
        },
        [`GET /api/files/${TOKEN}`]: () => {
          calls.push('file');
          return new Response(new Blob(['%PDF-1.4']), {
            status: 200,
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="receta-2026-10-19-abcd1234.pdf"',
            },
          });
        },
      },
    });
    globalThis.URL.createObjectURL = () => 'blob:test';
    globalThis.URL.revokeObjectURL = () => undefined;

    await user.click(await screen.findByRole('button', { name: 'Descargar PDF' }));

    await waitFor(() => {
      expect(calls).toEqual(['link', 'file']);
    });
  });
});
