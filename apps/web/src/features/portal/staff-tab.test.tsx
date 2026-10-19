import type { PortalIdentityDto } from '@consultorio/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { defaultRegistry } from '../../app/registry.js';
import { a11yViolations } from '../../shared/test/a11y.js';
import {
  fakeFetch,
  jsonBody,
  jsonResponse,
  problemResponse,
  renderWithApp,
  type FetchHandler,
} from '../../shared/test/render.js';

import { PatientPortalTab } from './PatientPortalTab.js';
import { SELF_LINK } from './portal-fixtures.js';

/**
 * The tab of the patient record for the portal (S5.10, task 5.41): who can sign in to read this
 * record, the invitations, and the ways to end an access.
 */
const PATIENT = '0190a000-0000-7000-8000-0000000000b1';

const IDENTITY: PortalIdentityDto = {
  id: '0190a000-0000-7000-8000-000000000501',
  email: 'ana@example.test',
  status: 'active',
  activatedAt: '2031-05-01T12:00:00.000Z',
  deactivatedAt: null,
  links: [SELF_LINK],
};

function open(extra: Record<string, FetchHandler | Response>) {
  return renderWithApp(<PatientPortalTab patientId={PATIENT} />, {
    fetch: fakeFetch({ ...extra }),
  });
}

describe('the portal tab of the patient record', () => {
  it('is registered for whoever manages the portal accounts', () => {
    const tab = defaultRegistry().slots.find(
      (piece) => piece.slot === 'patient-detail-tab' && piece.id === 'portal.invitation',
    );

    expect(tab).toMatchObject({ anyOf: ['portal.manage'], labelKey: 'portal:patientTab' });
  });

  it('says that nobody has access yet and offers the invitation', async () => {
    const app = open({
      [`GET /api/patients/${PATIENT}/portal`]: jsonResponse({ identities: [] }),
    });

    expect(await screen.findByText('Nadie tiene acceso al portal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invitar al paciente' })).toBeEnabled();
    expect(app.missingKeys).toEqual([]);
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('invites the patient themselves with no body', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    let invited = false;
    open({
      [`GET /api/patients/${PATIENT}/portal`]: () =>
        jsonResponse({
          identities: invited
            ? [{ ...IDENTITY, status: 'invited', activatedAt: null, links: [] }]
            : [],
        }),
      [`POST /api/patients/${PATIENT}/portal-invitation`]: (_url, init) => {
        bodies.push(jsonBody(init));
        invited = true;
        return jsonResponse(
          { identity: { ...IDENTITY, status: 'invited', activatedAt: null, links: [] } },
          201,
        );
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Invitar al paciente' }));

    expect(await screen.findByText('Invitación pendiente')).toBeInTheDocument();
    expect(screen.getByText('Todavía no abrió el enlace de la invitación.')).toBeInTheDocument();
    expect(bodies).toEqual([{}]);
    // The patient already has an invitation: a second one is not offered.
    expect(
      await screen.findByRole('button', { name: 'El paciente ya tiene acceso o una invitación' }),
    ).toBeDisabled();
  });

  it('explains why it cannot invite a patient with no email', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/patients/${PATIENT}/portal`]: jsonResponse({ identities: [] }),
      [`POST /api/patients/${PATIENT}/portal-invitation`]: problemResponse(
        422,
        'portal_patient_has_no_email',
      ),
    });

    await user.click(await screen.findByRole('button', { name: 'Invitar al paciente' }));

    expect(
      await screen.findByText(/Este paciente no tiene un correo registrado/),
    ).toBeInTheDocument();
  });

  it('lists the account with its access, and offers to end sessions, remove the access or deactivate', async () => {
    const app = open({
      [`GET /api/patients/${PATIENT}/portal`]: jsonResponse({ identities: [IDENTITY] }),
    });

    expect(await screen.findByText('ana@example.test')).toBeInTheDocument();
    expect(screen.getByText('Activo')).toBeInTheDocument();
    expect(screen.getByText(/Activo desde el/)).toBeInTheDocument();
    expect(screen.getByText('Su propia ficha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quitar este acceso' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar sus sesiones' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dar de baja la cuenta' })).toBeInTheDocument();
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('ends the sessions of an account', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      [`GET /api/patients/${PATIENT}/portal`]: jsonResponse({ identities: [IDENTITY] }),
      [`POST /api/portal-identities/${IDENTITY.id}/sessions/revoke`]: () => {
        calls.push('sessions');
        return jsonResponse({ identity: IDENTITY });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Cerrar sus sesiones' }));

    await waitFor(() => {
      expect(calls).toEqual(['sessions']);
    });
  });

  it('deactivates an account, which then offers nothing more', async () => {
    const user = userEvent.setup();
    let off = false;
    open({
      [`GET /api/patients/${PATIENT}/portal`]: () =>
        jsonResponse({
          identities: [
            off
              ? {
                  ...IDENTITY,
                  status: 'deactivated',
                  deactivatedAt: '2031-06-01T12:00:00.000Z',
                  links: [],
                }
              : IDENTITY,
          ],
        }),
      [`POST /api/portal-identities/${IDENTITY.id}/deactivate`]: () => {
        off = true;
        return jsonResponse({ identity: { ...IDENTITY, status: 'deactivated' } });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Dar de baja la cuenta' }));

    expect(await screen.findByText('Dado de baja')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dar de baja la cuenta' })).not.toBeInTheDocument();
    // A deactivated account does not count: the patient can be invited again.
    expect(screen.getByRole('button', { name: 'Invitar al paciente' })).toBeEnabled();
  });

  it('removes one access without touching the account', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      [`GET /api/patients/${PATIENT}/portal`]: jsonResponse({ identities: [IDENTITY] }),
      [`POST /api/portal-links/${SELF_LINK.id}/revoke`]: () => {
        calls.push('revoke');
        return jsonResponse({ identity: IDENTITY });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Quitar este acceso' }));

    await waitFor(() => {
      expect(calls).toEqual(['revoke']);
    });
  });

  it('asks for what was verified before inviting a representative, and sends the whole of it', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      [`GET /api/patients/${PATIENT}/portal`]: jsonResponse({ identities: [] }),
      [`POST /api/patients/${PATIENT}/portal-invitation`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({ identity: IDENTITY }, 201);
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Invitar al representante' }));
    expect(
      await screen.findByText(
        'Complete el correo y describa qué verificó (al menos 10 caracteres).',
      ),
    ).toBeInTheDocument();
    expect(bodies).toEqual([]);

    await user.type(
      screen.getByLabelText('Correo electrónico del representante'),
      'madre@example.test',
    );
    await user.selectOptions(screen.getByLabelText('Relación con el paciente'), 'guardian');
    await user.type(screen.getByLabelText('Qué verificó'), 'DNI y partida de nacimiento');
    await user.click(screen.getByRole('button', { name: 'Invitar al representante' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          email: 'madre@example.test',
          relation: 'guardian',
          verificationNote: 'DNI y partida de nacimiento',
        },
      ]);
    });
  });

  it('shows an error with a retry when the accounts cannot be read', async () => {
    const user = userEvent.setup();
    let fails = true;
    open({
      [`GET /api/patients/${PATIENT}/portal`]: () =>
        fails ? problemResponse(500, 'internal_error') : jsonResponse({ identities: [] }),
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fails = false;

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('Nadie tiene acceso al portal')).toBeInTheDocument();
  });
});
