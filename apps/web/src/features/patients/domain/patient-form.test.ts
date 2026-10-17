import type { PatientDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_PATIENT_FORM,
  ageInYears,
  buildPatientSchema,
  isMinor,
  toCreateRequest,
  toUpdateRequest,
  valuesFromPatient,
  type PatientFormValues,
} from './patient-form.js';

const TODAY = new Date('2026-10-16T12:00:00Z');

const valid: PatientFormValues = {
  ...EMPTY_PATIENT_FORM,
  familyName: 'Gómez',
  givenNames: 'Valentina',
  birthDate: '1988-05-04',
  documentType: 'dni',
  documentNumber: '30.123.456',
  consent: 'yes',
};

const issuesOf = (values: PatientFormValues, mode: 'create' | 'edit' = 'create') => {
  const result = buildPatientSchema({ mode, today: TODAY }).safeParse(values);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

describe('age', () => {
  it('counts whole years on a calendar day', () => {
    expect(ageInYears('1988-10-16', TODAY)).toBe(38);
    expect(ageInYears('1988-10-17', TODAY)).toBe(37);
    expect(ageInYears('2026-10-16', TODAY)).toBe(0);
  });

  it('a person under 18 is a minor, on the birthday they are not', () => {
    expect(isMinor('2008-10-17', TODAY)).toBe(true);
    expect(isMinor('2008-10-16', TODAY)).toBe(false);
    expect(isMinor('', TODAY)).toBe(false);
  });
});

describe('patient form validation', () => {
  it('accepts a complete registration', () => {
    expect(issuesOf(valid)).toEqual([]);
  });

  it('asks for the names and the birth date', () => {
    const issues = issuesOf({ ...valid, familyName: '', givenNames: ' ', birthDate: '' });

    expect(issues).toEqual(
      expect.arrayContaining([
        'familyName: validation.required',
        'givenNames: validation.required',
        'birthDate: validation.required',
      ]),
    );
  });

  it('does not accept a birth date in the future or a date that does not exist', () => {
    expect(issuesOf({ ...valid, birthDate: '2026-10-17' })).toContain(
      'birthDate: patients.form.error.birthFuture',
    );
    expect(issuesOf({ ...valid, birthDate: '2026-02-31' })).toContain(
      'birthDate: validation.invalid',
    );
  });

  it('validates the document with the rules of the country, per type', () => {
    expect(issuesOf({ ...valid, documentNumber: '12' })).toContain(
      'documentNumber: country.ar.national_id.invalid',
    );
    expect(issuesOf({ ...valid, documentNumber: '' })).toContain(
      'documentNumber: validation.required',
    );
    expect(issuesOf({ ...valid, documentType: 'passport', documentNumber: 'ab 123456' })).toEqual(
      [],
    );
    expect(issuesOf({ ...valid, documentType: 'passport', documentNumber: '!!' })).toContain(
      'documentNumber: country.ar.passport.invalid',
    );
  });

  it('lets a patient have no document, and then ignores the number', () => {
    expect(issuesOf({ ...valid, documentType: 'none', documentNumber: '' })).toEqual([]);
  });

  it('checks phone and email shapes only when they are filled', () => {
    expect(issuesOf({ ...valid, phone: '11 5555 0000', email: 'ana@example.test' })).toEqual([]);
    expect(issuesOf({ ...valid, phone: 'llamar a la tarde' })).toContain(
      'phone: validation.format',
    );
    expect(issuesOf({ ...valid, email: 'no-es-correo' })).toContain('email: validation.email');
  });

  it('needs both parts of an emergency contact or none', () => {
    expect(issuesOf({ ...valid, emergencyName: 'Marta', emergencyPhone: '' })).toContain(
      'emergencyPhone: validation.required',
    );
    expect(issuesOf({ ...valid, emergencyName: '', emergencyPhone: '11 4444 0000' })).toContain(
      'emergencyName: validation.required',
    );
    expect(issuesOf({ ...valid, emergencyName: 'Marta', emergencyPhone: '11 4444 0000' })).toEqual(
      [],
    );
  });

  it('the consent prompt must be answered when registering, not when editing', () => {
    expect(issuesOf({ ...valid, consent: '' })).toContain(
      'consent: patients.form.error.consentRequired',
    );
    expect(issuesOf({ ...valid, consent: 'no' })).toEqual([]);
    expect(issuesOf({ ...valid, consent: '' }, 'edit')).toEqual([]);
  });

  it('a minor needs a representative with a way to reach them', () => {
    const child = {
      ...valid,
      birthDate: '2019-03-10',
      documentType: 'none' as const,
      documentNumber: '',
    };

    expect(issuesOf(child)).toEqual(
      expect.arrayContaining([
        'representativeName: patients.form.error.representativeRequired',
        'representativeRelation: patients.form.error.representativeRequired',
        'representativeContact: patients.form.error.representativeContact',
      ]),
    );
    expect(
      issuesOf({
        ...child,
        representativeName: 'Lorena Gómez',
        representativeRelation: 'mother',
        representativePhone: '11 6666 0000',
      }),
    ).toEqual([]);
  });

  it('an adult does not need one, and editing a minor does not ask again', () => {
    expect(issuesOf(valid)).toEqual([]);
    expect(issuesOf({ ...valid, birthDate: '2019-03-10' }, 'edit')).toEqual([]);
  });
});

describe('request mapping', () => {
  it('builds the creation request, leaving out what was not typed', () => {
    expect(toCreateRequest({ ...valid, phone: '11 5555 0000', sex: 'female' })).toEqual({
      familyName: 'Gómez',
      givenNames: 'Valentina',
      birthDate: '1988-05-04',
      sex: 'female',
      document: { type: 'dni', number: '30.123.456' },
      phone: '11 5555 0000',
      dataProcessingConsent: true,
    });
  });

  it('a patient without a document sends null, and a refused consent sends false', () => {
    const request = toCreateRequest({
      ...valid,
      documentType: 'none',
      documentNumber: '',
      consent: 'no',
    });

    expect(request.document).toBeNull();
    expect(request.dataProcessingConsent).toBe(false);
  });

  it('includes the representative and the emergency contact when given', () => {
    const request = toCreateRequest({
      ...valid,
      emergencyName: 'Marta',
      emergencyPhone: '11 4444 0000',
      representativeName: 'Lorena',
      representativeRelation: 'mother',
      representativeEmail: 'lorena@example.test',
    });

    expect(request.emergencyContact).toEqual({ name: 'Marta', phone: '11 4444 0000' });
    expect(request.representative).toEqual({
      fullName: 'Lorena',
      relation: 'mother',
      email: 'lorena@example.test',
    });
  });

  const patient: PatientDto = {
    id: '0190a000-0000-7000-8000-0000000000e1',
    familyName: 'Gómez',
    givenNames: 'Valentina',
    birthDate: '1988-05-04',
    sex: 'female',
    document: { type: 'dni', number: '30123456' },
    noDocument: false,
    phone: '11 5555 0000',
    email: null,
    address: null,
    emergencyContact: null,
    adminNotes: null,
    status: 'active',
    origin: 'staff',
    hasSafetyFlag: false,
    consentStatus: 'granted',
    version: 3,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
  };

  it('fills the form from a patient', () => {
    expect(valuesFromPatient(patient)).toMatchObject({
      familyName: 'Gómez',
      documentType: 'dni',
      documentNumber: '30123456',
      sex: 'female',
      phone: '11 5555 0000',
      email: '',
    });
  });

  it('sends only what changed, with the version the edit started from', () => {
    const edited = {
      ...valuesFromPatient(patient),
      phone: '11 7777 0000',
      address: 'Calle Demo 123',
    };

    expect(toUpdateRequest(edited, patient)).toEqual({
      phone: '11 7777 0000',
      address: 'Calle Demo 123',
      expectedVersion: 3,
    });
  });

  it('clears a value that was emptied, and never removes a document', () => {
    const edited = { ...valuesFromPatient({ ...patient, email: 'a@example.test' }), email: '' };

    expect(toUpdateRequest(edited, { ...patient, email: 'a@example.test' })).toEqual({
      email: null,
      expectedVersion: 3,
    });
    expect(toUpdateRequest(valuesFromPatient(patient), patient)).toEqual({ expectedVersion: 3 });
  });

  it('adds a document to a patient that had none', () => {
    const none = { ...patient, document: null, noDocument: true };
    const edited = {
      ...valuesFromPatient(none),
      documentType: 'dni' as const,
      documentNumber: '40123456',
    };

    expect(toUpdateRequest(edited, none)).toEqual({
      document: { type: 'dni', number: '40123456' },
      expectedVersion: 3,
    });
  });
});
