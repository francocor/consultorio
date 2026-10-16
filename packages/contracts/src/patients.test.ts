import { describe, expect, it } from 'vitest';

import {
  CreatePatientRequest,
  PatientDto,
  PatientSearchQuery,
  RepresentativeInput,
  UpdatePatientRequest,
} from './patients.js';

const BASE = { familyName: 'Pérez', givenNames: 'Ana María', birthDate: '1990-05-17' };

describe('CreatePatientRequest', () => {
  it('registers a patient with only a name and a birth date (no document)', () => {
    expect(CreatePatientRequest.safeParse(BASE).success).toBe(true);
    expect(CreatePatientRequest.safeParse({ ...BASE, document: null }).success).toBe(true);
  });

  it('keeps the document type explicit', () => {
    expect(
      CreatePatientRequest.safeParse({ ...BASE, document: { type: 'dni', number: '30.123.456' } })
        .success,
    ).toBe(true);
    expect(
      CreatePatientRequest.safeParse({ ...BASE, document: { type: 'library_card', number: '1' } })
        .success,
    ).toBe(false);
    expect(
      CreatePatientRequest.safeParse({ ...BASE, document: { number: '30123456' } }).success,
    ).toBe(false);
  });

  it.each([
    [{ familyName: '' }],
    [{ givenNames: '   ' }],
    [{ birthDate: '17/05/1990' }],
    [{ birthDate: '1990-13-40' }],
    [{ phone: 'call me maybe' }],
    [{ email: 'not-an-address' }],
    [{ adminNotes: 'x'.repeat(1001) }],
  ])('rejects %j', (patch) => {
    expect(CreatePatientRequest.safeParse({ ...BASE, ...patch }).success).toBe(false);
  });

  it('cannot carry a safety flag, a tenant, a status or a version: the system owns them', () => {
    for (const extra of [
      { safetyFlags: ['allergy_on_file'] },
      { hasSafetyFlag: true },
      { tenantId: 'x' },
      { status: 'inactive' },
      { version: 3 },
      { origin: 'online' },
    ]) {
      expect(
        CreatePatientRequest.safeParse({ ...BASE, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe('UpdatePatientRequest', () => {
  it('needs a real change, and the expected version alone is not one', () => {
    expect(UpdatePatientRequest.safeParse({}).success).toBe(false);
    expect(UpdatePatientRequest.safeParse({ expectedVersion: 2 }).success).toBe(false);
    expect(
      UpdatePatientRequest.safeParse({ phone: '11 5555-1234', expectedVersion: 2 }).success,
    ).toBe(true);
  });

  it('adds or corrects a document but cannot remove it', () => {
    expect(
      UpdatePatientRequest.safeParse({ document: { type: 'dni', number: '30123456' } }).success,
    ).toBe(true);
    expect(UpdatePatientRequest.safeParse({ document: null }).success).toBe(false);
  });

  it('cannot carry a safety flag', () => {
    expect(UpdatePatientRequest.safeParse({ phone: '1', safetyFlags: [] }).success).toBe(false);
  });
});

describe('PatientSearchQuery', () => {
  it('defaults to active patients, 25 per page', () => {
    expect(PatientSearchQuery.parse({})).toEqual({ status: 'active', limit: 25 });
  });

  it('turns the limit from the query string into a number and caps it', () => {
    expect(PatientSearchQuery.parse({ limit: '50' }).limit).toBe(50);
    expect(PatientSearchQuery.safeParse({ limit: '101' }).success).toBe(false);
  });
});

describe('RepresentativeInput', () => {
  it('needs a way to reach the representative', () => {
    expect(RepresentativeInput.safeParse({ fullName: 'Rosa', relation: 'mother' }).success).toBe(
      false,
    );
    expect(
      RepresentativeInput.safeParse({ fullName: 'Rosa', relation: 'mother', phone: '11 4444-5555' })
        .success,
    ).toBe(true);
  });
});

describe('PatientDto', () => {
  it('has no clinical field', () => {
    const keys = Object.keys(PatientDto.shape).sort();

    expect(keys).toEqual(
      [
        'address',
        'adminNotes',
        'birthDate',
        'createdAt',
        'document',
        'emergencyContact',
        'email',
        'familyName',
        'givenNames',
        'hasSafetyFlag',
        'id',
        'noDocument',
        'origin',
        'phone',
        'sex',
        'status',
        'updatedAt',
        'version',
      ].sort(),
    );
  });
});
