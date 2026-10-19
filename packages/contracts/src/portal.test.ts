import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import {
  CreatePortalLinkRequest,
  PORTAL_AUDIT_ACTIONS,
  PORTAL_ERRORS,
  PORTAL_IDENTITY_STATUSES,
  PORTAL_LINK_RELATIONSHIPS,
  PORTAL_LINK_STATUSES,
  PortalInvitationRequest,
  ChangePortalEmailRequest,
} from './portal.js';

describe('portal catalogues', () => {
  it('has the identity and link states of the design', () => {
    expect([...PORTAL_IDENTITY_STATUSES]).toEqual(['invited', 'active', 'deactivated']);
    expect([...PORTAL_LINK_RELATIONSHIPS]).toEqual(['self', 'representative']);
    expect([...PORTAL_LINK_STATUSES]).toEqual(['active', 'suspended', 'revoked']);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(PORTAL_AUDIT_ACTIONS).toEqual([
      'portal.identity.created',
      'portal.identity.linked',
      'portal.identity.deactivated',
      'portal.signin.success',
      'portal.signin.failure',
      'portal.read',
      'portal.download',
      'portal.profile.changed',
      'portal.denied',
    ]);
    for (const action of PORTAL_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('has an error catalog that is part of the API catalog', () => {
    // Typed as a plain catalog: once the track fills it in, it has its own literal shape.
    const catalog: Readonly<Record<string, { status: number; i18nKey: string }>> = PORTAL_ERRORS;
    for (const [code, entry] of Object.entries(catalog)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});

describe('the staff requests of the portal accounts', () => {
  it('invites the patient themselves with an empty body', () => {
    expect(PortalInvitationRequest.parse({})).toEqual({});
  });

  it('invites a representative only with the email, the relation and the verification note', () => {
    const full = {
      email: 'Madre@Example.test ',
      relation: 'mother',
      verificationNote: 'Presentó el DNI propio y la partida de nacimiento en el mostrador.',
    };

    expect(PortalInvitationRequest.parse(full)).toEqual({ ...full, email: 'madre@example.test' });
    expect(PortalInvitationRequest.safeParse({ email: 'madre@example.test' }).success).toBe(false);
    expect(PortalInvitationRequest.safeParse({ ...full, verificationNote: 'ok' }).success).toBe(
      false,
    );
    expect(PortalInvitationRequest.safeParse({ relation: 'mother' }).success).toBe(false);
  });

  it('links another dependent with a patient, a relation and the verification note', () => {
    const body = {
      patientId: '0190a000-0000-7000-8000-000000000001',
      relation: 'father',
      verificationNote: 'Verificado en persona con la partida de nacimiento.',
    };

    expect(CreatePortalLinkRequest.parse(body)).toEqual(body);
    expect(CreatePortalLinkRequest.safeParse({ ...body, relation: 'cousin' }).success).toBe(false);
    expect(CreatePortalLinkRequest.safeParse({ ...body, patientId: 'x' }).success).toBe(false);
  });

  it('changes the email only with the note of the out-of-band verification', () => {
    const body = {
      email: 'nuevo@example.test',
      verificationNote: 'Verificó su identidad por teléfono.',
    };

    expect(ChangePortalEmailRequest.parse(body)).toEqual(body);
    expect(ChangePortalEmailRequest.safeParse({ email: 'nuevo@example.test' }).success).toBe(false);
    expect(ChangePortalEmailRequest.safeParse({ ...body, email: 'no-es-un-correo' }).success).toBe(
      false,
    );
  });
});
