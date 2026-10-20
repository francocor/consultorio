import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  ARCHIVE_PLATFORM_AUDIT_ACTIONS,
  ARCHIVE_RELEASE_CHECKLIST,
  ArchiveOverviewDto,
  CANCELLATION_AUDIT_ACTIONS,
  CANCELLATION_ERRORS,
  CANCELLATION_PLATFORM_AUDIT_ACTIONS,
  EXPORT_PACKAGE_KINDS,
  ExportPackageDto,
  ExportPackageResponse,
  RecordArchiveReleaseRequest,
  VerifyArchiveReleaseIdentityRequest,
} from './cancellation.js';
import { ERROR_CATALOG } from './errors.js';
import { isPlatformAuditAction } from './operator.js';

describe('cancellation and archive catalogues', () => {
  it('splits the export in two parts: one administrative and one clinical per professional', () => {
    expect([...EXPORT_PACKAGE_KINDS]).toEqual(['administrative', 'clinical']);
  });

  it('registers the cancellation actions of the organization in the tenant catalogue, once each', () => {
    expect(CANCELLATION_AUDIT_ACTIONS).toEqual([
      'tenant.cancelled',
      'export.cancellation.requested',
      'export.cancellation.downloaded',
    ]);
    for (const action of CANCELLATION_AUDIT_ACTIONS) {
      expect(
        AUDIT_ACTIONS.filter((known) => known === action),
        action,
      ).toHaveLength(1);
    }
  });

  it('writes what the platform does with a cancelled organization in the platform trail only', () => {
    expect(CANCELLATION_PLATFORM_AUDIT_ACTIONS).toEqual(['tenant.cancelled']);
    expect(ARCHIVE_PLATFORM_AUDIT_ACTIONS).toEqual([
      'archive.written',
      'archive.verified',
      'archive.accessed',
      'archive.released',
      'archive.erased',
    ]);
    for (const action of [
      ...CANCELLATION_PLATFORM_AUDIT_ACTIONS,
      ...ARCHIVE_PLATFORM_AUDIT_ACTIONS,
    ]) {
      expect(isPlatformAuditAction(action), action).toBe(true);
    }
    for (const action of ARCHIVE_PLATFORM_AUDIT_ACTIONS) {
      expect(AUDIT_ACTIONS as readonly string[], action).not.toContain(action);
    }
  });

  it('has an error catalog that is part of the API catalog', () => {
    const catalog: Readonly<Record<string, { status: number; i18nKey: string }>> =
      CANCELLATION_ERRORS;
    for (const [code, entry] of Object.entries(catalog)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});

describe('the shapes of the cancellation export', () => {
  const dto = {
    id: '0190a000-0000-7000-8000-000000000001',
    kind: 'administrative',
    status: 'ready',
    fileName: 'exportacion-administrativa-20310531.zip',
    sizeBytes: 2048,
    builtAt: '2031-05-31T18:00:00.000Z',
    failureCode: null,
  };

  it('describes a package by its state and file, never by its content', () => {
    expect(ExportPackageDto.parse(dto)).toEqual(dto);
    expect(Object.keys(ExportPackageDto.shape).sort()).toEqual([
      'builtAt',
      'failureCode',
      'fileName',
      'id',
      'kind',
      'sizeBytes',
      'status',
    ]);
  });

  it('refuses a status or a kind the table does not have, and any extra field', () => {
    expect(ExportPackageDto.safeParse({ ...dto, status: 'building' }).success).toBe(false);
    expect(ExportPackageDto.safeParse({ ...dto, kind: 'custody' }).success).toBe(false);
    expect(ExportPackageDto.safeParse({ ...dto, objectKey: 't/x/y' }).success).toBe(false);
  });

  it('answers a missing package with null so the screen can say "not yet"', () => {
    expect(ExportPackageResponse.parse({ package: null })).toEqual({ package: null });
    expect(ExportPackageResponse.parse({ package: dto })).toEqual({ package: dto });
  });
});

describe('the shapes of the break-glass release', () => {
  const patient = {
    organization: '0190a000-0000-7000-8000-000000000001',
    requesterKind: 'patient',
    requesterName: 'Ana Ríos',
    requesterEmail: ' ANA@EJEMPLO.test ',
    documentType: 'dni',
    document: '20111222',
    reason: 'Necesito mi historia clínica para una segunda opinión',
  };

  it('accepts a patient found by document and a professional found by registration, and normalizes the address', () => {
    expect(RecordArchiveReleaseRequest.parse(patient)).toMatchObject({
      requesterKind: 'patient',
      requesterEmail: 'ana@ejemplo.test',
    });
    expect(
      RecordArchiveReleaseRequest.parse({
        organization: patient.organization,
        requesterKind: 'professional',
        requesterName: 'Dr. Soto',
        requesterEmail: 'soto@ejemplo.test',
        matriculaJurisdiction: 'AR-B',
        matricula: '700123',
        reason: 'Continuidad de la atención de mis pacientes',
      }).requesterKind,
    ).toBe('professional');
  });

  it('limits the requesters to a patient and a professional, and refuses the fields of the other kind', () => {
    expect(
      RecordArchiveReleaseRequest.safeParse({ ...patient, requesterKind: 'lawyer' }).success,
    ).toBe(false);
    // A patient without a document, and a patient with a registration.
    expect(RecordArchiveReleaseRequest.safeParse({ ...patient, document: undefined }).success).toBe(
      false,
    );
    expect(
      RecordArchiveReleaseRequest.safeParse({
        ...patient,
        matricula: '123',
        matriculaJurisdiction: 'AR-B',
      }).success,
    ).toBe(false);
    expect(
      RecordArchiveReleaseRequest.safeParse({
        ...patient,
        requesterKind: 'professional',
        matriculaJurisdiction: 'AR-B',
        matricula: '700123',
      }).success,
    ).toBe(false);
  });

  it('wants every item of the identity checklist ticked', () => {
    const all = {
      documentChecked: true,
      photoMatches: true,
      contactConfirmed: true,
      entitlementChecked: true,
    };

    expect(VerifyArchiveReleaseIdentityRequest.safeParse(all).success).toBe(true);
    for (const item of ARCHIVE_RELEASE_CHECKLIST) {
      expect(
        VerifyArchiveReleaseIdentityRequest.safeParse({ ...all, [item]: false }).success,
        item,
      ).toBe(false);
    }
    expect(VerifyArchiveReleaseIdentityRequest.safeParse({ ...all, extra: true }).success).toBe(
      false,
    );
  });

  it('describes the archive of an organization by counts and dates only', () => {
    expect(Object.keys(ArchiveOverviewDto.shape).sort()).toEqual([
      'archivedAt',
      'bytes',
      'objects',
      'organization',
      'retainUntil',
      'status',
      'verifiedAt',
      'verifyProblems',
      'verifyStatus',
    ]);
  });
});
