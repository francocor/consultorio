import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';
import { IDS, LOCATIONS, MEMBERS } from '../staff/fixtures.js';

import { stateFor, type StateOptions } from './fixtures.js';

type Handler = (url: string, init: RequestInit) => Response;

/** What `PUT /branding` answers once the blue style is saved. */
const BRANDING_SAVED = {
  branding: {
    displayName: 'Consultorio Sur',
    shortName: 'Consultorio Sur',
    primaryRequested: '#1e40af',
    primaryEffective: '#1e40af',
    primaryForeground: '#ffffff',
    radius: 'sm',
    headingFont: 'source_sans',
    logoUrl: null,
  },
  contrast: {
    requested: '#1e40af',
    effective: '#1e40af',
    foreground: '#ffffff',
    adjusted: false,
    ratio: 8.7,
    warning: null,
  },
};

interface Options {
  state?: StateOptions;
  me?: ReturnType<typeof meFor>;
  path?: string;
  routes?: Record<string, Handler>;
  locations?: typeof LOCATIONS;
}

function open({
  state,
  me = meFor(['owner']),
  path = '/onboarding',
  routes,
  locations,
}: Options = {}) {
  const current = stateFor(state);
  return renderApp({
    me,
    path,
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/onboarding/state': () => jsonResponse(current),
      'PUT /api/onboarding/state': () => jsonResponse(current),
      'GET /api/staff': () => jsonResponse({ staff: MEMBERS }),
      'GET /api/locations': () => jsonResponse({ locations: locations ?? LOCATIONS }),
      'GET /api/appointment-types': () => jsonResponse({ types: [] }),
      [`GET /api/professionals/${IDS.professionalProfile}/hours`]: () =>
        jsonResponse({ professionalId: IDS.professionalProfile, hours: [] }),
      ...routes,
    },
  });
}

const h1 = (name: string) => screen.findByRole('heading', { level: 1, name });
const h2 = (name: string) => screen.findByRole('heading', { level: 2, name });

describe('the way in', () => {
  it('offers the quick setup and the step by step on the first visit', async () => {
    const app = open();

    expect(await h1('Configuración inicial')).toBeInTheDocument();
    expect(await h2('¿Cómo quiere empezar?')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Usar la configuración rápida' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configurar paso a paso' })).toBeInTheDocument();
    expect(await a11yViolations(document.body)).toEqual([]);
    expect(app.missingKeys).toEqual([]);
  });

  it('does not show the choice again once the person went step by step', async () => {
    open({ state: { answers: { path: 'center' } } });

    expect(await h2('Su perfil')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '¿Cómo quiere empezar?' }),
    ).not.toBeInTheDocument();
  });

  it('remembers the choice of going step by step', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      routes: {
        'PUT /api/onboarding/state': (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(stateFor({ answers: { path: 'center' } }));
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Configurar paso a paso' }));

    await waitFor(() => {
      expect(body).toEqual({ answers: { path: 'center' } });
    });
  });
});

describe('the quick setup of a solo professional', () => {
  async function openFastPath(routes: Record<string, Handler> = {}) {
    const user = userEvent.setup();
    const app = open({ routes });
    await user.click(await screen.findByRole('button', { name: 'Usar la configuración rápida' }));
    await h2('Configuración rápida');
    return { user, app };
  }

  it('asks only who attends, creates everything and says the consultorio is ready', async () => {
    let body: unknown;
    const { user, app } = await openFastPath({
      'POST /api/onboarding/fast-path': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({
          state: stateFor({ completed: true }),
          created: { professional: true, location: true, hours: true, appointmentType: true },
          readyToBook: true,
        });
      },
    });
    expect(await a11yViolations(document.body)).toEqual([]);

    await user.type(screen.getByLabelText('Nombre y apellido'), 'Lic. Mario Gómez');
    await user.type(screen.getByLabelText('Profesión o especialidad'), 'Psicología');
    await user.click(screen.getByRole('button', { name: 'Dejar todo listo' }));

    expect(await h2('Su consultorio está listo')).toBeInTheDocument();
    expect(body).toEqual({ fullName: 'Lic. Mario Gómez', specialties: ['Psicología'] });
    expect(screen.getByRole('link', { name: 'Ir a la agenda' })).toHaveAttribute(
      'href',
      '/calendar',
    );
    expect(screen.getByRole('link', { name: 'Registrar un paciente' })).toHaveAttribute(
      'href',
      '/patients/new',
    );
    expect(screen.getByText(/lunes a viernes de 9 a 17/i)).toBeInTheDocument();
    expect(await a11yViolations(document.body)).toEqual([]);
    expect(app.missingKeys).toEqual([]);
  });

  it('sends the name of the consultorio when the person types one', async () => {
    let body: unknown;
    const { user } = await openFastPath({
      'POST /api/onboarding/fast-path': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({
          state: stateFor({ completed: true }),
          created: { professional: true, location: true, hours: true, appointmentType: true },
          readyToBook: true,
        });
      },
    });

    await user.type(screen.getByLabelText('Nombre y apellido'), 'Dra. Ana Pérez');
    await user.type(screen.getByLabelText('Profesión o especialidad'), 'Clínica médica');
    await user.type(screen.getByLabelText('Nombre del consultorio'), 'Consultorio Palermo');
    await user.click(screen.getByRole('button', { name: 'Dejar todo listo' }));

    await h2('Su consultorio está listo');
    expect(body).toEqual({
      fullName: 'Dra. Ana Pérez',
      specialties: ['Clínica médica'],
      locationName: 'Consultorio Palermo',
    });
  });

  it('shows what is missing inline, in Spanish, and sends nothing', async () => {
    const { user, app } = await openFastPath();

    await user.click(screen.getByRole('button', { name: 'Dejar todo listo' }));

    expect(await screen.findAllByText('Este dato es obligatorio.')).toHaveLength(2);
    expect(app.requests).not.toContain('POST /api/onboarding/fast-path');
  });

  it('explains a failure without technical detail and keeps what was typed', async () => {
    const { user } = await openFastPath({
      'POST /api/onboarding/fast-path': () => problemResponse(403, 'forbidden'),
    });
    await user.type(screen.getByLabelText('Nombre y apellido'), 'Lic. Mario Gómez');
    await user.type(screen.getByLabelText('Profesión o especialidad'), 'Psicología');

    await user.click(screen.getByRole('button', { name: 'Dejar todo listo' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre y apellido')).toHaveValue('Lic. Mario Gómez');
  });
});

describe('the steps', () => {
  it('resumes at the saved step, with the earlier steps marked as done', async () => {
    const app = open({
      state: {
        currentStep: 'hours',
        steps: { profile: 'done' },
        answers: { isProfessional: true, path: 'center' },
        missing: ['hours', 'appointment_type'],
      },
    });

    expect(await h2('Días y horarios de atención')).toBeInTheDocument();
    const steps = screen.getByRole('navigation', { name: 'Pasos de la configuración' });
    expect(within(steps).getByRole('button', { name: /Su perfil/ })).toHaveTextContent('Hecho');
    expect(within(steps).getByRole('button', { name: /Días y horarios/ })).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(screen.getByText('Paso 3 de 6')).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('opens the step named in the address', async () => {
    open({ path: '/onboarding?step=appointment_types', state: { answers: { path: 'center' } } });

    expect(await h2('Tipo de turno')).toBeInTheDocument();
  });

  describe('profile', () => {
    async function openProfile(routes: Record<string, Handler> = {}) {
      const user = userEvent.setup();
      const app = open({ state: { answers: { path: 'center' } }, routes });
      await h2('Su perfil');
      return { user, app };
    }

    it('records a professional with the optional matricula and moves on', async () => {
      let professional: unknown;
      let cursor: unknown;
      const { user, app } = await openProfile({
        'POST /api/onboarding/professional': (_url, init) => {
          professional = jsonBody(init);
          return jsonResponse(stateFor({ steps: { profile: 'done' } }));
        },
        'PUT /api/onboarding/state': (_url, init) => {
          cursor = jsonBody(init);
          return jsonResponse(stateFor({ currentStep: 'location' }));
        },
      });
      expect(await a11yViolations(document.body)).toEqual([]);

      await user.click(screen.getByRole('radio', { name: /Sí, soy profesional de la salud/ }));
      await user.type(await screen.findByLabelText('Nombre y apellido'), 'Dra. Ana Pérez');
      await user.type(screen.getByLabelText('Profesión o especialidad'), 'Pediatría');
      await user.selectOptions(screen.getByLabelText('Jurisdicción de la matrícula'), 'AR-B');
      await user.type(screen.getByLabelText('Número de matrícula'), '123456');
      await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));

      await waitFor(() => {
        expect(cursor).toEqual({ currentStep: 'location' });
      });
      expect(professional).toEqual({
        isProfessional: true,
        fullName: 'Dra. Ana Pérez',
        specialties: ['Pediatría'],
        matricula: { jurisdiction: 'AR-B', number: '123456' },
      });
      expect(app.missingKeys).toEqual([]);
    });

    it('lets the matricula wait: without a jurisdiction none is sent', async () => {
      let professional: unknown;
      const { user } = await openProfile({
        'POST /api/onboarding/professional': (_url, init) => {
          professional = jsonBody(init);
          return jsonResponse(stateFor({ steps: { profile: 'done' } }));
        },
      });

      await user.click(screen.getByRole('radio', { name: /Sí, soy profesional de la salud/ }));
      await user.type(await screen.findByLabelText('Nombre y apellido'), 'Dra. Ana Pérez');
      await user.type(screen.getByLabelText('Profesión o especialidad'), 'Pediatría');
      await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));

      await waitFor(() => {
        expect(professional).toMatchObject({ isProfessional: true, matricula: null });
      });
    });

    it('says "no": no clinical access, and the team step is where professionals come in', async () => {
      let professional: unknown;
      const { user } = await openProfile({
        'POST /api/onboarding/professional': (_url, init) => {
          professional = jsonBody(init);
          return jsonResponse(stateFor({ steps: { profile: 'done' } }));
        },
      });

      await user.click(screen.getByRole('radio', { name: /No, administro el centro/ }));

      expect(await screen.findByText(/necesita al menos un profesional/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Nombre y apellido')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));
      await waitFor(() => {
        expect(professional).toEqual({ isProfessional: false });
      });
    });

    it('asks for the missing pieces inline before sending', async () => {
      const { user, app } = await openProfile();

      await user.click(screen.getByRole('radio', { name: /Sí, soy profesional de la salud/ }));
      await user.click(await screen.findByRole('button', { name: 'Guardar y continuar' }));

      expect((await screen.findAllByText('Este dato es obligatorio.')).length).toBeGreaterThan(0);
      expect(app.requests).not.toContain('POST /api/onboarding/professional');
    });
  });

  describe('location', () => {
    it('creates the first place and moves on', async () => {
      const user = userEvent.setup();
      let body: unknown;
      let cursor: unknown;
      open({
        locations: [],
        state: { currentStep: 'location', steps: { profile: 'done' }, answers: { path: 'center' } },
        routes: {
          'POST /api/locations': (_url, init) => {
            body = jsonBody(init);
            return jsonResponse(
              {
                id: IDS.central,
                name: 'Consultorio Palermo',
                timeZone: 'America/Argentina/Buenos_Aires',
                active: true,
              },
              201,
            );
          },
          'PUT /api/onboarding/state': (_url, init) => {
            cursor = jsonBody(init);
            return jsonResponse(stateFor({ currentStep: 'hours' }));
          },
        },
      });

      await h2('Su consultorio');
      expect(await a11yViolations(document.body)).toEqual([]);
      await user.type(screen.getByLabelText('Nombre del consultorio'), 'Consultorio Palermo');
      await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));

      await waitFor(() => {
        expect(cursor).toEqual({ currentStep: 'hours' });
      });
      expect(body).toEqual({ name: 'Consultorio Palermo' });
    });

    it('reuses a place that already exists instead of asking for another', async () => {
      open({
        state: { currentStep: 'location', steps: { profile: 'done' }, answers: { path: 'center' } },
      });

      await h2('Su consultorio');
      expect(await screen.findByText('Sede Central')).toBeInTheDocument();
      expect(screen.queryByLabelText('Nombre del consultorio')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Administrar sedes' })).toHaveAttribute(
        'href',
        '/settings/locations',
      );
    });

    it('does not offer to skip a required step', async () => {
      open({
        locations: [],
        state: { currentStep: 'location', steps: { profile: 'done' }, answers: { path: 'center' } },
      });

      await h2('Su consultorio');
      expect(screen.queryByRole('button', { name: 'Omitir por ahora' })).not.toBeInTheDocument();
    });
  });

  describe('working hours', () => {
    const resume = {
      currentStep: 'hours',
      steps: { profile: 'done', location: 'done' },
      answers: { isProfessional: true, path: 'center' },
    } as const;

    it('saves the chosen days and times for the professional at the place', async () => {
      const user = userEvent.setup();
      let body: unknown;
      let cursor: unknown;
      const app = open({
        state: resume,
        routes: {
          [`PUT /api/professionals/${IDS.professionalProfile}/hours`]: (_url, init) => {
            body = jsonBody(init);
            return jsonResponse({ professionalId: IDS.professionalProfile, hours: [] });
          },
          'PUT /api/onboarding/state': (_url, init) => {
            cursor = jsonBody(init);
            return jsonResponse(stateFor({ currentStep: 'appointment_types' }));
          },
        },
      });

      await h2('Días y horarios de atención');
      expect(await a11yViolations(document.body)).toEqual([]);
      // Monday to Friday are chosen from the start; Friday goes, and the day ends at 13:00.
      const days = await screen.findByRole('group', { name: 'Días de atención' });
      await user.click(within(days).getByRole('checkbox', { name: /Viernes/ }));
      fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '13:00' } });
      await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));

      await waitFor(() => {
        expect(cursor).toEqual({ currentStep: 'appointment_types' });
      });
      expect(body).toEqual({
        hours: [1, 2, 3, 4].map((weekday) => ({
          locationId: IDS.central,
          weekday,
          start: '09:00',
          end: '13:00',
        })),
      });
      expect(app.missingKeys).toEqual([]);
    });

    it('refuses an end before the start and a week with no day, inline', async () => {
      const user = userEvent.setup();
      const app = open({ state: resume });
      await h2('Días y horarios de atención');
      const days = await screen.findByRole('group', { name: 'Días de atención' });

      fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '08:00' } });
      await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));
      expect(
        await screen.findByText('La hora de fin debe ser posterior a la de inicio.'),
      ).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '17:00' } });
      for (const day of within(days).getAllByRole('checkbox')) {
        if ((day as HTMLInputElement).getAttribute('aria-checked') === 'true')
          await user.click(day);
      }
      await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));
      expect(await screen.findByText('Elija al menos un día.')).toBeInTheDocument();
      expect(app.requests).not.toContain(`PUT /api/professionals/${IDS.professionalProfile}/hours`);
    });

    it('shows the current schedule when there is one', async () => {
      open({
        state: resume,
        routes: {
          [`GET /api/professionals/${IDS.professionalProfile}/hours`]: () =>
            jsonResponse({
              professionalId: IDS.professionalProfile,
              hours: [1, 2, 3, 4, 5].map((weekday) => ({
                locationId: IDS.central,
                weekday,
                start: '09:00',
                end: '17:00',
              })),
            }),
        },
      });

      expect(
        await screen.findByText('Horario actual: Lunes a viernes, 09:00–17:00'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cambiar horario' })).toBeInTheDocument();
    });

    it('explains there is nobody to set hours for, and points to the team step', async () => {
      const user = userEvent.setup();
      open({
        state: resume,
        routes: { 'GET /api/staff': () => jsonResponse({ staff: [MEMBERS[0], MEMBERS[2]] }) },
      });

      expect(await screen.findByText('Todavía no hay profesionales')).toBeInTheDocument();
      expect(await a11yViolations(document.body)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Ir a «Su equipo»' }));
      expect(await h2('Su equipo')).toBeInTheDocument();
    });
  });

  describe('appointment types', () => {
    const resume = {
      currentStep: 'appointment_types',
      steps: { profile: 'done', location: 'done', hours: 'done' },
      answers: { path: 'center' },
    } as const;

    it('creates the first type with a name and a duration', async () => {
      const user = userEvent.setup();
      let body: unknown;
      open({
        state: resume,
        routes: {
          'POST /api/appointment-types': (_url, init) => {
            body = jsonBody(init);
            return jsonResponse(
              {
                id: IDS.central,
                name: 'Primera consulta',
                description: null,
                durationMinutes: 45,
                bufferMinutes: 0,
                mode: 'in_person',
                priceReference: null,
                requiresApproval: false,
                color: null,
                professionalIds: [],
                specialties: [],
                active: true,
              },
              201,
            );
          },
        },
      });

      await h2('Tipo de turno');
      expect(await a11yViolations(document.body)).toEqual([]);
      await user.type(screen.getByLabelText('Nombre'), 'Primera consulta');
      await user.selectOptions(screen.getByLabelText('Duración'), '45');
      await user.click(screen.getByRole('button', { name: 'Agregar tipo de turno' }));

      await waitFor(() => {
        expect(body).toEqual({
          name: 'Primera consulta',
          durationMinutes: 45,
          mode: 'in_person',
        });
      });
    });

    it('lists the types that exist and lets the person continue', async () => {
      open({
        state: resume,
        routes: {
          'GET /api/appointment-types': () =>
            jsonResponse({
              types: [
                {
                  id: IDS.central,
                  name: 'Consulta',
                  description: null,
                  durationMinutes: 30,
                  bufferMinutes: 0,
                  mode: 'in_person',
                  priceReference: null,
                  requiresApproval: false,
                  color: null,
                  professionalIds: [],
                  specialties: [],
                  active: true,
                },
              ],
            }),
        },
      });

      const list = await screen.findByRole('list', { name: 'Tipos de turno creados' });
      expect(within(list).getByText('Consulta')).toBeInTheDocument();
      expect(within(list).getByText('30 min')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Guardar y continuar' })).toBeEnabled();
    });

    it('does not let the person continue without a type', async () => {
      open({ state: resume });

      await h2('Tipo de turno');
      expect(
        await screen.findByText('Cree al menos un tipo de turno para continuar.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Guardar y continuar' })).toBeDisabled();
    });
  });

  describe('team', () => {
    const resume = {
      currentStep: 'team',
      steps: { profile: 'done', location: 'done', hours: 'done', appointment_types: 'done' },
      answers: { path: 'center' },
    } as const;

    it('invites reception by email, after checking what it does to the plan', async () => {
      const user = userEvent.setup();
      let invitation: unknown;
      const app = open({
        state: resume,
        routes: {
          'GET /api/onboarding/invitation-impact': () => jsonResponse({ affectsPlan: false }),
          'POST /api/staff/invitations': (_url, init) => {
            invitation = jsonBody(init);
            return jsonResponse({ expiresAt: '2026-10-24T12:00:00.000Z' }, 201);
          },
        },
      });

      await h2('Su equipo');
      expect(await a11yViolations(document.body)).toEqual([]);
      await user.type(screen.getByLabelText('Correo electrónico'), 'recepcion@clinica.example');
      await user.selectOptions(screen.getByLabelText('Rol'), 'reception');
      await user.click(screen.getByRole('button', { name: 'Enviar invitación' }));

      const sent = await screen.findByRole('list', { name: 'Invitaciones enviadas' });
      expect(within(sent).getByText(/recepcion@clinica.example/)).toBeInTheDocument();
      expect(invitation).toEqual({ email: 'recepcion@clinica.example', roles: ['reception'] });
      expect(app.requests.indexOf('GET /api/onboarding/invitation-impact')).toBeLessThan(
        app.requests.indexOf('POST /api/staff/invitations'),
      );
      expect(app.missingKeys).toEqual([]);
    });

    it('shows the effect on the plan and waits for a confirmation before sending', async () => {
      const user = userEvent.setup();
      let sent = false;
      open({
        state: resume,
        routes: {
          'GET /api/onboarding/invitation-impact': () => jsonResponse({ affectsPlan: true }),
          'POST /api/staff/invitations': () => {
            sent = true;
            return jsonResponse({ expiresAt: '2026-10-24T12:00:00.000Z' }, 201);
          },
        },
      });

      await h2('Su equipo');
      await user.type(screen.getByLabelText('Correo electrónico'), 'medica@clinica.example');
      await user.selectOptions(screen.getByLabelText('Rol'), 'professional');
      await user.click(screen.getByRole('button', { name: 'Enviar invitación' }));

      expect(await screen.findByText('Esta invitación puede cambiar su plan')).toBeInTheDocument();
      expect(sent).toBe(false);
      await user.click(screen.getByRole('button', { name: 'Confirmar y enviar' }));
      await waitFor(() => {
        expect(sent).toBe(true);
      });
    });

    it('offers the roles the person may hand out: an admin may invite professionals, and is told the owners get an email', async () => {
      const user = userEvent.setup();
      open({
        state: resume,
        me: meFor(['admin'], { grants: ['onboarding.manage'] }),
      });

      await h2('Su equipo');
      const role = screen.getByLabelText('Rol');
      expect(within(role).getByRole('option', { name: 'Recepción' })).toBeInTheDocument();
      expect(within(role).getByRole('option', { name: 'Administración' })).toBeInTheDocument();
      expect(within(role).getByRole('option', { name: 'Profesional' })).toBeInTheDocument();
      expect(screen.queryByText(/avisaremos por correo a los titulares/)).not.toBeInTheDocument();

      await user.selectOptions(role, 'professional');

      expect(screen.getByText(/avisaremos por correo a los titulares/)).toBeInTheDocument();
    });

    it('can be skipped, and the cursor moves on', async () => {
      const user = userEvent.setup();
      let body: unknown;
      open({
        state: resume,
        routes: {
          'PUT /api/onboarding/state': (_url, init) => {
            body = jsonBody(init);
            return jsonResponse(stateFor({ currentStep: 'branding' }));
          },
        },
      });

      await h2('Su equipo');
      await user.click(screen.getByRole('button', { name: 'Omitir por ahora' }));

      await waitFor(() => {
        expect(body).toEqual({ step: { id: 'team', status: 'skipped' }, currentStep: 'branding' });
      });
    });
  });

  describe('branding', () => {
    const resume = {
      currentStep: 'branding',
      steps: {
        profile: 'done',
        location: 'done',
        hours: 'done',
        appointment_types: 'done',
        team: 'skipped',
      },
      answers: { path: 'center' },
      missing: [],
    } as const;

    it('saves the name and the style chosen', async () => {
      const user = userEvent.setup();
      let identity: unknown;
      open({
        state: resume,
        routes: {
          'PUT /api/branding': (_url, init) => {
            identity = jsonBody(init);
            return jsonResponse(BRANDING_SAVED);
          },
        },
      });

      await h2('Identidad visual');
      expect(await a11yViolations(document.body)).toEqual([]);
      const name = screen.getByLabelText('Nombre que se muestra');
      await user.clear(name);
      await user.type(name, 'Consultorio Sur');
      await user.click(screen.getByRole('radio', { name: /Azul/ }));
      await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));

      await waitFor(() => {
        expect(identity).toEqual({
          displayName: 'Consultorio Sur',
          shortName: 'Consultorio Sur',
          primaryColor: '#1e40af',
          radius: 'sm',
          headingFont: 'source_sans',
        });
      });
    });

    it('is skipped without touching the default look, going to the review', async () => {
      const user = userEvent.setup();
      let progress: unknown;
      const app = open({
        state: resume,
        routes: {
          'PUT /api/onboarding/state': (_url, init) => {
            progress = jsonBody(init);
            return jsonResponse(stateFor(resume));
          },
        },
      });

      await h2('Identidad visual');
      await user.click(screen.getByRole('button', { name: 'Omitir por ahora' }));

      expect(await h2('Revisar y finalizar')).toBeInTheDocument();
      expect(progress).toEqual({ step: { id: 'branding', status: 'skipped' } });
      expect(app.requests).not.toContain('PUT /api/branding');
    });
  });
});

describe('finishing', () => {
  it('blocks the end while something required is missing, and says what', async () => {
    const user = userEvent.setup();
    const app = open({
      path: '/onboarding?step=review',
      state: {
        answers: { path: 'center' },
        missing: ['location', 'professional', 'appointment_type'],
      },
      routes: {
        'POST /api/onboarding/complete': () => problemResponse(400, 'validation_failed'),
      },
    });

    await h2('Revisar y finalizar');
    expect(await a11yViolations(document.body)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Finalizar configuración' }));

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('Todavía falta lo necesario para dar el primer turno:'),
    ).toBeInTheDocument();
    expect(within(alert).getByText('Falta crear un consultorio o sede.')).toBeInTheDocument();
    expect(within(alert).getByText('Falta al menos un profesional.')).toBeInTheDocument();
    expect(within(alert).getByText('Falta crear un tipo de turno.')).toBeInTheDocument();
    expect(app.router.state.location.pathname).toBe('/onboarding');
  });

  it('finishes when everything required exists and goes to the start page', async () => {
    const user = userEvent.setup();
    const app = open({
      path: '/onboarding?step=review',
      state: { answers: { path: 'center' }, missing: [] },
      routes: {
        'POST /api/onboarding/complete': () => jsonResponse(stateFor({ completed: true })),
      },
    });

    await h2('Revisar y finalizar');
    await user.click(screen.getByRole('button', { name: 'Finalizar configuración' }));

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/');
    });
    expect(app.requests).toContain('POST /api/onboarding/complete');
  });

  it('can be reopened after it is finished, to review any step', async () => {
    open({ state: { completed: true, steps: { profile: 'done', location: 'done' } } });

    expect(await screen.findByText(/ya está finalizada/)).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '¿Cómo quiere empezar?' }),
    ).not.toBeInTheDocument();
    const steps = screen.getByRole('navigation', { name: 'Pasos de la configuración' });
    expect(within(steps).getByRole('button', { name: /Su consultorio/ })).toBeInTheDocument();
  });
});

describe('who can run the wizard', () => {
  it.each([
    ['reception', meFor(['reception'])],
    ['a professional', meFor(['professional'])],
    ['an admin without the grant', meFor(['admin'])],
  ])('shows "no access" to %s without asking the server for anything', async (_name, me) => {
    const app = open({ me });

    expect(
      await screen.findByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
    expect(app.requests.filter((request) => request.includes('/api/onboarding'))).toEqual([]);
  });

  it('lets an admin in once the owner granted the permission', async () => {
    open({ me: meFor(['admin'], { grants: ['onboarding.manage'] }) });

    expect(await h1('Configuración inicial')).toBeInTheDocument();
  });

  it('shows a retryable error when the progress cannot be loaded', async () => {
    const user = userEvent.setup();
    let calls = 0;
    open({
      routes: {
        'GET /api/onboarding/state': () => {
          calls += 1;
          return calls === 1 ? problemResponse(500, 'internal_error') : jsonResponse(stateFor());
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));

    expect(await h2('¿Cómo quiere empezar?')).toBeInTheDocument();
  });
});
