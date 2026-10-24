import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import {
  CreatePortalLinkRequest,
  PORTAL_RESPONSE_SCHEMAS,
  PortalConsentSignRequest,
  PortalProfileUpdateRequest,
  PortalCodeRequest,
  PortalCodeVerifyRequest,
  PortalRegisterRequest,
  PortalRegisterVerifyRequest,
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
      'portal.notice.sent',
      'portal.notice.expired',
      'portal.registration.opened',
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

describe('the public requests of the portal', () => {
  const proof = 'x'.repeat(40);

  it('registers with the document and the email on the record, and the proof of the challenge', () => {
    expect(
      PortalRegisterRequest.parse({
        nationalId: ' 30.123.456 ',
        email: 'Ana@Example.test',
        challengeProof: proof,
      }),
    ).toEqual({ nationalId: '30.123.456', email: 'ana@example.test', challengeProof: proof });
    expect(
      PortalRegisterRequest.safeParse({ nationalId: '30123456', email: 'ana@example.test' })
        .success,
    ).toBe(false);
    expect(
      PortalRegisterRequest.safeParse({
        nationalId: '',
        email: 'ana@example.test',
        challengeProof: proof,
      }).success,
    ).toBe(false);
  });

  it('asks for a code with an email and the proof, and verifies with six digits', () => {
    expect(PortalCodeRequest.parse({ email: 'ana@example.test', challengeProof: proof })).toEqual({
      email: 'ana@example.test',
      challengeProof: proof,
    });
    expect(PortalCodeVerifyRequest.parse({ email: 'ana@example.test', code: '048213' })).toEqual({
      email: 'ana@example.test',
      code: '048213',
    });
    for (const code of ['12345', '1234567', 'abcdef', '12 456']) {
      expect(PortalCodeVerifyRequest.safeParse({ email: 'ana@example.test', code }).success).toBe(
        false,
      );
    }
  });

  it('verifies a registration with the document again, because the code names no patient', () => {
    const body = { nationalId: '30123456', email: 'ana@example.test', code: '048213' };

    expect(PortalRegisterVerifyRequest.parse(body)).toEqual(body);
    expect(
      PortalRegisterVerifyRequest.safeParse({ email: body.email, code: body.code }).success,
    ).toBe(false);
  });
});

/** Names no shape of the portal may carry: the clinical record is never displayed there (design D11). */
const CLINICAL_FIELD_NAMES = new Set([
  'note',
  'notes',
  'clinicalNote',
  'diagnosis',
  'diagnoses',
  'anamnesis',
  'symptoms',
  'treatment',
  'evolution',
  'encounter',
  'encounterId',
  'medication',
  'medications',
  'items',
  'lines',
  'safetyFlags',
  'adminNotes',
]);

function propertyNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) propertyNames(item, out);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        for (const name of Object.keys(value as object)) out.add(name);
      }
      propertyNames(value, out);
    }
  }
}

describe('what the portal can ever carry (design D11, patient-portal "Documents shared with the patient")', () => {
  it('has no clinical note, diagnosis, anamnesis, medication or internal note in any response', () => {
    const checked: string[] = [];
    for (const [name, schema] of Object.entries(PORTAL_RESPONSE_SCHEMAS)) {
      const names = new Set<string>();
      propertyNames(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }), names);
      expect(
        [...names].filter((field) => CLINICAL_FIELD_NAMES.has(field)),
        name,
      ).toEqual([]);
      checked.push(name);
    }
    expect(checked.length).toBeGreaterThanOrEqual(10);
  });

  it('would notice a clinical field (the check proves itself)', () => {
    const schema = z.strictObject({ appointment: z.strictObject({ diagnosis: z.string() }) });
    const names = new Set<string>();

    propertyNames(z.toJSONSchema(schema, { io: 'output' }), names);

    expect([...names].filter((field) => CLINICAL_FIELD_NAMES.has(field))).toEqual(['diagnosis']);
  });

  it('lets the patient change only contact fields: a name, a document or a birth date is refused', () => {
    expect(PortalProfileUpdateRequest.parse({ phone: '+54 11 5555 0000' })).toEqual({
      phone: '+54 11 5555 0000',
    });
    expect(PortalProfileUpdateRequest.safeParse({ phone: '1', familyName: 'Otro' }).success).toBe(
      false,
    );
    expect(PortalProfileUpdateRequest.safeParse({ birthDate: '1990-01-01' }).success).toBe(false);
    expect(PortalProfileUpdateRequest.safeParse({}).success).toBe(false);
    expect(PortalProfileUpdateRequest.safeParse({ phone: 'abc' }).success).toBe(false);
  });

  it('asks for the explicit acceptance to sign', () => {
    const base = {
      contentHash: 'a'.repeat(64),
      signerName: 'Ana Pérez',
      signature: { kind: 'typed', value: 'Ana Pérez' },
    };

    expect(PortalConsentSignRequest.safeParse({ ...base, accepted: true }).success).toBe(true);
    expect(PortalConsentSignRequest.safeParse({ ...base, accepted: false }).success).toBe(false);
    expect(PortalConsentSignRequest.safeParse(base).success).toBe(false);
  });

  it('binds the signature to the text it was shown: the hash is required and is a SHA-256 in hex (JD-S5 R1-B-S4)', () => {
    const base = {
      accepted: true,
      signerName: 'Ana Pérez',
      signature: { kind: 'typed', value: 'Ana Pérez' },
    };

    expect(PortalConsentSignRequest.safeParse(base).success).toBe(false);
    expect(PortalConsentSignRequest.safeParse({ ...base, contentHash: 'abc' }).success).toBe(false);
    expect(
      PortalConsentSignRequest.safeParse({ ...base, contentHash: 'A'.repeat(64) }).success,
    ).toBe(false);
  });

  it('limits the mark: a typed one to 120 characters, a drawn one to a PNG data URL (JD-S5 R1-S5-5)', () => {
    const base = { accepted: true, contentHash: 'a'.repeat(64), signerName: 'Ana Pérez' };
    const typed = (value: string) => ({ ...base, signature: { kind: 'typed', value } });
    const drawn = (value: string) => ({ ...base, signature: { kind: 'drawn', value } });

    expect(PortalConsentSignRequest.safeParse(typed('x'.repeat(120))).success).toBe(true);
    expect(PortalConsentSignRequest.safeParse(typed('x'.repeat(121))).success).toBe(false);
    expect(PortalConsentSignRequest.safeParse(typed('a'.repeat(150_000))).success).toBe(false);
    expect(
      PortalConsentSignRequest.safeParse(drawn('data:image/png;base64,iVBORw0KGgo=')).success,
    ).toBe(true);
    for (const value of [
      'https://evil.example/pixel.png',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png,not-base64',
    ]) {
      expect(PortalConsentSignRequest.safeParse(drawn(value)).success).toBe(false);
    }
    expect(
      PortalConsentSignRequest.safeParse(drawn(`data:image/png;base64,${'A'.repeat(150_000)}`))
        .success,
    ).toBe(false);
  });
});
