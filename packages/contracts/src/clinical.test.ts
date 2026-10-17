import { describe, expect, it } from 'vitest';

import {
  AddAddendumRequest,
  ClinicalSearchQuery,
  MarkEnteredInErrorRequest,
  OpenEncounterRequest,
  SaveDraftRequest,
  TimelineQuery,
} from './clinical.js';

const PATIENT = '0190a000-0000-7000-8000-0000000000aa';

describe('OpenEncounterRequest', () => {
  it('opens an encounter for a patient with a template', () => {
    const parsed = OpenEncounterRequest.parse({ patientId: PATIENT, templateKind: 'general' });

    expect(parsed).toEqual({ patientId: PATIENT, templateKind: 'general' });
  });

  it('ignores an author sent in the body: the author is the session, never the request', () => {
    const parsed = OpenEncounterRequest.parse({
      patientId: PATIENT,
      templateKind: 'psychology',
      authorProfessionalId: '0190a000-0000-7000-8000-0000000000bb',
      tenantId: 'x',
    });

    expect(parsed).toEqual({ patientId: PATIENT, templateKind: 'psychology' });
  });

  it('accepts the appointment link and the author-only restriction, and refuses unknown values', () => {
    expect(
      OpenEncounterRequest.safeParse({
        patientId: PATIENT,
        templateKind: 'nutrition',
        appointmentId: PATIENT,
        visibility: 'author_only',
      }).success,
    ).toBe(true);
    for (const bad of [
      { patientId: 'not-a-uuid', templateKind: 'general' },
      { patientId: PATIENT, templateKind: 'astrology' },
      { patientId: PATIENT, templateKind: 'general', visibility: 'everyone' },
    ]) {
      expect(OpenEncounterRequest.safeParse(bad).success).toBe(false);
    }
  });
});

describe('SaveDraftRequest', () => {
  it('carries the content and the revision it was based on', () => {
    const parsed = SaveDraftRequest.parse({ content: { symptoms: 'Tos' }, baseRevision: 0 });

    expect(parsed).toEqual({ content: { symptoms: 'Tos' }, baseRevision: 0 });
  });

  it('refuses a negative or fractional revision and a content that is not an object', () => {
    for (const bad of [
      { content: {}, baseRevision: -1 },
      { content: {}, baseRevision: 1.5 },
      { content: 'text', baseRevision: 0 },
      { content: [], baseRevision: 0 },
      { baseRevision: 0 },
    ]) {
      expect(SaveDraftRequest.safeParse(bad).success).toBe(false);
    }
  });
});

describe('addendum and entered-in-error requests', () => {
  it('needs a kind, a reason and a text', () => {
    expect(
      AddAddendumRequest.safeParse({
        kind: 'correction',
        reason: 'Corrected diagnosis',
        text: 'Diagnosis is B',
      }).success,
    ).toBe(true);
    expect(
      AddAddendumRequest.safeParse({
        kind: 'rectification',
        reason: 'Pedido del paciente',
        text: 'Alergia a la dipirona',
      }).success,
    ).toBe(true);
  });

  it('rejects an addendum with no reason, a blank one, or an unknown kind', () => {
    const base = { kind: 'correction', reason: 'Motivo', text: 'Texto' };
    for (const bad of [
      { ...base, reason: '' },
      { ...base, reason: '   ' },
      { ...base, text: '' },
      { ...base, kind: 'opinion' },
      { kind: 'correction', text: 'Texto' },
    ]) {
      expect(AddAddendumRequest.safeParse(bad).success).toBe(false);
    }
  });

  it('requires a reason to mark an entry in error', () => {
    expect(MarkEnteredInErrorRequest.safeParse({ reason: 'Paciente equivocado' }).success).toBe(
      true,
    );
    expect(MarkEnteredInErrorRequest.safeParse({ reason: ' ' }).success).toBe(false);
    expect(MarkEnteredInErrorRequest.safeParse({}).success).toBe(false);
  });
});

describe('timeline and search queries', () => {
  it('reads the timeline options from the query string', () => {
    expect(TimelineQuery.parse({})).toEqual({ includeErrors: false, limit: 50 });
    expect(TimelineQuery.parse({ includeErrors: 'true', limit: '20' })).toEqual({
      includeErrors: true,
      limit: 20,
    });
    expect(TimelineQuery.safeParse({ limit: '1000' }).success).toBe(false);
    expect(TimelineQuery.safeParse({ includeErrors: 'maybe' }).success).toBe(false);
  });

  it('needs at least two characters to search, and an optional date range', () => {
    expect(ClinicalSearchQuery.parse({ q: ' hipertensión ' })).toEqual({ q: 'hipertensión' });
    expect(ClinicalSearchQuery.parse({ q: 'tos', from: '2026-01-01', to: '2026-03-31' })).toEqual({
      q: 'tos',
      from: '2026-01-01',
      to: '2026-03-31',
    });
    for (const bad of [{ q: 'a' }, { q: '' }, { q: 'tos', from: '01/01/2026' }, {}]) {
      expect(ClinicalSearchQuery.safeParse(bad).success).toBe(false);
    }
  });

  it('refuses a range that ends before it starts', () => {
    expect(
      ClinicalSearchQuery.safeParse({ q: 'tos', from: '2026-05-01', to: '2026-04-01' }).success,
    ).toBe(false);
  });
});
