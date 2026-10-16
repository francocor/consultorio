import {
  PATIENT_SEXES,
  REPRESENTATIVE_RELATIONS,
  validateNationalId,
  validatePassport,
  type CreatePatientRequest,
  type PatientDto,
  type UpdatePatientRequest,
} from '@consultorio/contracts';
import { z } from 'zod';

/** Age of majority in Argentina. The server applies the country pack; this only guides the form. */
export const MAJORITY_AGE = 18;

export type DocumentChoice = 'dni' | 'passport' | 'none';
type Sex = (typeof PATIENT_SEXES)[number];
type Relation = (typeof REPRESENTATIVE_RELATIONS)[number];

/** Every field of the registration form, as text: what the person typed. */
export interface PatientFormValues {
  familyName: string;
  givenNames: string;
  birthDate: string;
  sex: Sex | '';
  documentType: DocumentChoice;
  documentNumber: string;
  phone: string;
  email: string;
  address: string;
  emergencyName: string;
  emergencyPhone: string;
  adminNotes: string;
  /** The consent prompt of the registration: must be answered when creating. */
  consent: 'yes' | 'no' | '';
  representativeName: string;
  representativeRelation: Relation | '';
  representativePhone: string;
  representativeEmail: string;
}

export const EMPTY_PATIENT_FORM: PatientFormValues = {
  familyName: '',
  givenNames: '',
  birthDate: '',
  sex: '',
  documentType: 'dni',
  documentNumber: '',
  phone: '',
  email: '',
  address: '',
  emergencyName: '',
  emergencyPhone: '',
  adminNotes: '',
  consent: '',
  representativeName: '',
  representativeRelation: '',
  representativePhone: '',
  representativeEmail: '',
};

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const PHONE = /^[0-9+()\-\s.]*$/;

function parseDay(value: string): Date | null {
  const match = ISO_DAY.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  // `2026-02-31` rolls over into March: that is not a date.
  return date.toISOString().slice(0, 10) === value ? date : null;
}

/** Whole years between a birth date (a calendar day) and today. */
export function ageInYears(birthDate: string, today: Date): number {
  const born = parseDay(birthDate);
  if (!born) return Number.NaN;
  let years = today.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < born.getUTCMonth() ||
    (today.getUTCMonth() === born.getUTCMonth() && today.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) years -= 1;
  return years;
}

export function isMinor(birthDate: string, today: Date): boolean {
  const age = ageInYears(birthDate, today);
  return !Number.isNaN(age) && age < MAJORITY_AGE;
}

/** The registration (or edit) form as one schema; every message is a translation key. */
export function buildPatientSchema(options: { mode: 'create' | 'edit'; today: Date }) {
  const { mode, today } = options;
  return z
    .object({
      familyName: z.string().trim().min(1).max(80),
      givenNames: z.string().trim().min(1).max(80),
      birthDate: z.string(),
      sex: z.enum(['', ...PATIENT_SEXES]),
      documentType: z.enum(['dni', 'passport', 'none']),
      documentNumber: z.string().trim(),
      phone: z.string().trim().max(30),
      email: z.string().trim().max(254),
      address: z.string().trim().max(300),
      emergencyName: z.string().trim().max(80),
      emergencyPhone: z.string().trim().max(30),
      adminNotes: z.string().trim().max(1000),
      consent: z.enum(['', 'yes', 'no']),
      representativeName: z.string().trim().max(80),
      representativeRelation: z.enum(['', ...REPRESENTATIVE_RELATIONS]),
      representativePhone: z.string().trim().max(30),
      representativeEmail: z.string().trim().max(254),
    })
    .superRefine((values, ctx) => {
      const add = (path: string, message: string) => {
        ctx.addIssue({ code: 'custom', path: [path], message });
      };

      if (values.birthDate === '') {
        add('birthDate', 'validation.required');
      } else {
        const born = parseDay(values.birthDate);
        if (!born) add('birthDate', 'validation.invalid');
        else if (born.getTime() > today.getTime())
          add('birthDate', 'patients.form.error.birthFuture');
      }

      if (values.documentType !== 'none') {
        if (values.documentNumber === '') add('documentNumber', 'validation.required');
        else {
          const checked =
            values.documentType === 'dni'
              ? validateNationalId(values.documentNumber)
              : validatePassport(values.documentNumber);
          if (!checked.ok) add('documentNumber', checked.error.i18nKey);
        }
      }

      if (values.phone !== '' && !PHONE.test(values.phone)) add('phone', 'validation.format');
      if (values.email !== '' && !z.email().safeParse(values.email).success) {
        add('email', 'validation.email');
      }

      if (values.emergencyName !== '' && values.emergencyPhone === '') {
        add('emergencyPhone', 'validation.required');
      }
      if (values.emergencyPhone !== '' && values.emergencyName === '') {
        add('emergencyName', 'validation.required');
      }
      if (values.emergencyPhone !== '' && !PHONE.test(values.emergencyPhone)) {
        add('emergencyPhone', 'validation.format');
      }

      if (mode === 'create' && values.consent !== 'yes' && values.consent !== 'no') {
        add('consent', 'patients.form.error.consentRequired');
      }

      const representativeStarted =
        values.representativeName !== '' ||
        values.representativePhone !== '' ||
        values.representativeEmail !== '';
      if (mode === 'create' && (isMinor(values.birthDate, today) || representativeStarted)) {
        if (values.representativeName === '') {
          add('representativeName', 'patients.form.error.representativeRequired');
        }
        if (values.representativeRelation === '') {
          add('representativeRelation', 'patients.form.error.representativeRequired');
        }
        if (values.representativePhone === '' && values.representativeEmail === '') {
          add('representativeContact', 'patients.form.error.representativeContact');
        }
        if (
          values.representativeEmail !== '' &&
          !z.email().safeParse(values.representativeEmail).success
        ) {
          add('representativeEmail', 'validation.email');
        }
      }
    });
}

const blank = (value: string) => (value.trim() === '' ? undefined : value.trim());

export function toCreateRequest(values: PatientFormValues): CreatePatientRequest {
  const request: CreatePatientRequest = {
    familyName: values.familyName.trim(),
    givenNames: values.givenNames.trim(),
    birthDate: values.birthDate,
    dataProcessingConsent: values.consent === 'yes',
    document:
      values.documentType === 'none'
        ? null
        : { type: values.documentType, number: values.documentNumber.trim() },
  };
  if (values.sex !== '') request.sex = values.sex;
  const phone = blank(values.phone);
  if (phone) request.phone = phone;
  const email = blank(values.email);
  if (email) request.email = email;
  const address = blank(values.address);
  if (address) request.address = address;
  const notes = blank(values.adminNotes);
  if (notes) request.adminNotes = notes;
  if (values.emergencyName.trim() !== '') {
    request.emergencyContact = {
      name: values.emergencyName.trim(),
      phone: values.emergencyPhone.trim(),
    };
  }
  if (values.representativeName.trim() !== '' && values.representativeRelation !== '') {
    request.representative = {
      fullName: values.representativeName.trim(),
      relation: values.representativeRelation,
      ...(blank(values.representativePhone) ? { phone: values.representativePhone.trim() } : {}),
      ...(blank(values.representativeEmail) ? { email: values.representativeEmail.trim() } : {}),
    };
  }
  return request;
}

export function valuesFromPatient(patient: PatientDto): PatientFormValues {
  return {
    ...EMPTY_PATIENT_FORM,
    familyName: patient.familyName,
    givenNames: patient.givenNames,
    birthDate: patient.birthDate,
    sex: patient.sex ?? '',
    documentType: patient.document
      ? patient.document.type === 'passport'
        ? 'passport'
        : 'dni'
      : 'none',
    documentNumber: patient.document?.number ?? '',
    phone: patient.phone ?? '',
    email: patient.email ?? '',
    address: patient.address ?? '',
    emergencyName: patient.emergencyContact?.name ?? '',
    emergencyPhone: patient.emergencyContact?.phone ?? '',
    adminNotes: patient.adminNotes ?? '',
  };
}

/**
 * Only the fields that changed, plus the version the edit started from (so a stale edit gets a
 * conflict instead of overwriting someone else's change). A document is added or corrected, never
 * removed; an emptied field is sent as `null` to clear it.
 */
export function toUpdateRequest(
  values: PatientFormValues,
  original: PatientDto,
): UpdatePatientRequest {
  const before = valuesFromPatient(original);
  const request: UpdatePatientRequest = { expectedVersion: original.version };
  if (values.familyName.trim() !== before.familyName) request.familyName = values.familyName.trim();
  if (values.givenNames.trim() !== before.givenNames) request.givenNames = values.givenNames.trim();
  if (values.birthDate !== before.birthDate) request.birthDate = values.birthDate;
  if (values.sex !== before.sex) request.sex = values.sex === '' ? null : values.sex;
  if (
    values.documentType !== 'none' &&
    (values.documentType !== before.documentType ||
      values.documentNumber.trim() !== before.documentNumber)
  ) {
    request.document = { type: values.documentType, number: values.documentNumber.trim() };
  }
  const textFields = ['phone', 'email', 'address', 'adminNotes'] as const;
  for (const field of textFields) {
    if (values[field].trim() !== before[field]) request[field] = blank(values[field]) ?? null;
  }
  if (
    values.emergencyName.trim() !== before.emergencyName ||
    values.emergencyPhone.trim() !== before.emergencyPhone
  ) {
    request.emergencyContact =
      values.emergencyName.trim() === ''
        ? null
        : { name: values.emergencyName.trim(), phone: values.emergencyPhone.trim() };
  }
  return request;
}
