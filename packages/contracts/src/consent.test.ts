import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  CONSENT_AUDIT_ACTIONS,
  CONSENT_ERRORS,
  CONSENT_METHODS,
  CONSENT_REQUEST_STATUSES,
  CONSENT_SIGNER_KINDS,
  CONSENT_TEMPLATE_STATUSES,
  CreateConsentTemplateRequest,
  UpdateConsentTemplateRequest,
} from './consent.js';
import { ERROR_CATALOG } from './errors.js';

describe('consent catalogues', () => {
  it('has the template and request states of the spec', () => {
    expect([...CONSENT_TEMPLATE_STATUSES]).toEqual(['draft', 'published', 'retired']);
    expect([...CONSENT_REQUEST_STATUSES]).toEqual([
      'pending',
      'signed',
      'declined',
      'expired',
      'revoked',
    ]);
  });

  it('knows how a consent is collected and who signs it', () => {
    expect([...CONSENT_METHODS]).toEqual(['in_person', 'portal']);
    expect([...CONSENT_SIGNER_KINDS]).toEqual(['patient', 'representative']);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(CONSENT_AUDIT_ACTIONS).toEqual([
      'consent.template.created',
      'consent.template.published',
      'consent.template.retired',
      'consent.requested',
      'consent.signed',
      'consent.revoked',
      'consent.read',
      'consent.expired',
      'consent.declined',
      'consent.integrity_failed',
    ]);
    for (const action of CONSENT_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('has an error catalog that is part of the API catalog', () => {
    // Typed as a plain catalog: once the track fills it in, it has its own literal shape.
    const catalog: Readonly<Record<string, { status: number; i18nKey: string }>> = CONSENT_ERRORS;
    for (const [code, entry] of Object.entries(catalog)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});

describe('template requests', () => {
  const valid = { title: 'Extracción dental', body: 'Autorizo la extracción.' };

  it('accepts a title and a text, with an optional specialty and starter', () => {
    expect(CreateConsentTemplateRequest.safeParse(valid).success).toBe(true);
    expect(
      CreateConsentTemplateRequest.safeParse({
        ...valid,
        specialty: 'odontology',
        starterKey: 'odontology_extraction',
        appointmentTypeId: null,
      }).success,
    ).toBe(true);
  });

  it('refuses a blank title, a blank text, a text that is too long and a specialty that is not a key', () => {
    for (const bad of [
      { ...valid, title: '   ' },
      { ...valid, body: '   \t ' },
      { ...valid, body: 'x'.repeat(20_001) },
      { ...valid, specialty: 'Odontología' },
    ]) {
      expect(
        CreateConsentTemplateRequest.safeParse(bad).success,
        JSON.stringify(bad).slice(0, 40),
      ).toBe(false);
    }
  });

  it('knows no field beyond its own: a tenant or a patient never comes in the body', () => {
    expect(CreateConsentTemplateRequest.safeParse({ ...valid, tenantId: 'x' }).success).toBe(false);
    expect(UpdateConsentTemplateRequest.safeParse({ patientId: 'x' }).success).toBe(false);
  });

  it('needs at least one change to edit a template', () => {
    expect(UpdateConsentTemplateRequest.safeParse({}).success).toBe(false);
    expect(UpdateConsentTemplateRequest.safeParse({ specialty: null }).success).toBe(true);
    expect(UpdateConsentTemplateRequest.safeParse({ body: 'Nuevo texto.' }).success).toBe(true);
  });
});
