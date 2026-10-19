import { randomUUID } from 'node:crypto';

import type {
  PortalConsentDetailDto,
  PortalConsentDto,
  PortalConsentSignRequest,
  PortalPrescriptionDto,
} from '@consultorio/contracts';

import type {
  PortalCall,
  PortalConsentPort,
  PortalFile,
  PortalPrescriptionPort,
} from '../../src/modules/portal/index.js';
import { AppError } from '../../src/platform/http/problem.js';

/**
 * Stand-ins for the doors of the consent and e-prescription modules, which are built on other
 * branches and wired by the integrator. They behave the way the ports promise: they answer for the
 * patient of the call and for nobody else, and `null` for what is not the subject's. They keep what
 * they were called with, so a test can prove the patient came from the session.
 */

interface ConsentRecord {
  id: string;
  patientId: string;
  title: string;
  body: string;
  status: PortalConsentDto['status'];
  requestedAt: Date;
  signedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  file: PortalFile | null;
  signedWith?: PortalConsentSignRequest;
  revokedBecause?: string | undefined;
}

export interface FakePortalConsents extends PortalConsentPort {
  /** What the port was called with, in order. */
  readonly calls: { method: string; patientId: string; identityId: string; consentId?: string }[];
  seed(
    patientId: string,
    values?: Partial<Pick<ConsentRecord, 'title' | 'body' | 'status' | 'expiresAt' | 'file'>>,
  ): string;
  recordOf(id: string): ConsentRecord | undefined;
}

function dto(record: ConsentRecord): PortalConsentDto {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    requestedAt: record.requestedAt.toISOString(),
    signedAt: record.signedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    canSign: record.status === 'pending',
    canRevoke: record.status === 'signed',
    hasDocument: record.file !== null,
  };
}

export function createFakePortalConsents(): FakePortalConsents {
  const records = new Map<string, ConsentRecord>();
  const calls: FakePortalConsents['calls'] = [];
  const log = (method: string, call: PortalCall, consentId?: string) =>
    calls.push({
      method,
      patientId: call.subject.patientId,
      identityId: call.actor.identityId,
      ...(consentId === undefined ? {} : { consentId }),
    });
  const ownOf = (call: PortalCall, consentId: string) => {
    const record = records.get(consentId);
    return record?.patientId === call.subject.patientId ? record : undefined;
  };

  return {
    calls,
    seed(patientId, values = {}) {
      const id = randomUUID();
      records.set(id, {
        id,
        patientId,
        title: values.title ?? 'Consentimiento para un procedimiento',
        body: values.body ?? 'Texto completo del consentimiento que se le pide firmar.',
        status: values.status ?? 'pending',
        requestedAt: new Date('2031-05-01T12:00:00.000Z'),
        signedAt: values.status === 'signed' ? new Date('2031-05-02T12:00:00.000Z') : null,
        revokedAt: null,
        expiresAt: values.expiresAt ?? null,
        file: values.file ?? null,
      });
      return id;
    },
    recordOf: (id) => records.get(id),
    list(_tx, call) {
      log('list', call);
      return Promise.resolve(
        [...records.values()].filter((r) => r.patientId === call.subject.patientId).map(dto),
      );
    },
    read(_tx, call) {
      log('read', call, call.consentId);
      const record = ownOf(call, call.consentId);
      const detail: PortalConsentDetailDto | null = record
        ? {
            ...dto(record),
            body: record.body,
            contentHash: 'f'.repeat(64),
            requiresRepresentative: call.subject.relationship === 'representative',
          }
        : null;
      return Promise.resolve(detail);
    },
    sign(_tx, call) {
      log('sign', call, call.consentId);
      const record = ownOf(call, call.consentId);
      if (!record) return Promise.resolve(null);
      if (record.status !== 'pending') return Promise.reject(new AppError('conflict'));
      if (call.subject.relationship === 'representative' && !call.request.representative) {
        return Promise.reject(new AppError('validation_failed'));
      }
      record.status = 'signed';
      record.signedAt = new Date('2031-05-05T12:00:00.000Z');
      record.signedWith = call.request;
      record.file = {
        objectKey: `signed/${record.id}.pdf`,
        fileName: 'consentimiento-firmado.pdf',
        contentType: 'application/pdf',
      };
      return Promise.resolve(dto(record));
    },
    revoke(_tx, call) {
      log('revoke', call, call.consentId);
      const record = ownOf(call, call.consentId);
      if (!record) return Promise.resolve(null);
      if (record.status !== 'signed') return Promise.reject(new AppError('conflict'));
      record.status = 'revoked';
      record.revokedAt = new Date('2031-05-06T12:00:00.000Z');
      record.revokedBecause = call.request.reason;
      return Promise.resolve(dto(record));
    },
    document(_tx, call) {
      log('document', call, call.consentId);
      return Promise.resolve(ownOf(call, call.consentId)?.file ?? null);
    },
  };
}

interface PrescriptionRecord {
  id: string;
  patientId: string;
  status: PortalPrescriptionDto['status'];
  issuedAt: Date | null;
  prescriberName: string | null;
  file: PortalFile | null;
}

export interface FakePortalPrescriptions extends PortalPrescriptionPort {
  readonly calls: { method: string; patientId: string; identityId: string }[];
  seed(
    patientId: string,
    values?: Partial<Pick<PrescriptionRecord, 'status' | 'prescriberName' | 'file'>>,
  ): string;
}

export function createFakePortalPrescriptions(): FakePortalPrescriptions {
  const records = new Map<string, PrescriptionRecord>();
  const calls: FakePortalPrescriptions['calls'] = [];
  return {
    calls,
    seed(patientId, values = {}) {
      const id = randomUUID();
      records.set(id, {
        id,
        patientId,
        status: values.status ?? 'issued',
        issuedAt: new Date('2031-05-03T12:00:00.000Z'),
        prescriberName: values.prescriberName ?? 'Dra. Ejemplo',
        file: values.file ?? null,
      });
      return id;
    },
    list(_tx, call) {
      calls.push({
        method: 'list',
        patientId: call.subject.patientId,
        identityId: call.actor.identityId,
      });
      return Promise.resolve(
        [...records.values()]
          .filter((r) => r.patientId === call.subject.patientId)
          .map((r): PortalPrescriptionDto => ({
            id: r.id,
            issuedAt: r.issuedAt?.toISOString() ?? null,
            status: r.status,
            prescriberName: r.prescriberName,
            hasDocument: r.file !== null,
          })),
      );
    },
    document(_tx, call) {
      calls.push({
        method: 'document',
        patientId: call.subject.patientId,
        identityId: call.actor.identityId,
      });
      const record = records.get(call.prescriptionId);
      return Promise.resolve(record?.patientId === call.subject.patientId ? record.file : null);
    },
  };
}
