import { describe, expect, it } from 'vitest';

import type { PortalCall } from './ports.js';
import {
  adaptPrescriptionModule,
  fileNameOf,
  type ModulePrescription,
  type PrescriptionModuleInput,
  type PrescriptionModulePortal,
} from './prescription-adapter.js';

/**
 * The adapter between the portal and the prescriptions module: the module lists confirmed
 * prescriptions only, and the portal passes it the subject of the session, never an id of a request.
 */
const TX = {} as never;
const CALL = {
  actor: { identityId: 'identity-1' },
  subject: { patientId: 'patient-1' },
  auditActor: { actingRole: 'patient', userId: null },
} as unknown as PortalCall;
const ID = '0190a000-0000-7000-8000-000000000b01';

function moduleOf(
  listed: ModulePrescription[],
  delivery: Awaited<ReturnType<PrescriptionModulePortal['openDocument']>>,
) {
  const calls: { fn: string; input: PrescriptionModuleInput }[] = [];
  const module: PrescriptionModulePortal = {
    list: (input) => {
      calls.push({ fn: 'list', input });
      return Promise.resolve(listed);
    },
    openDocument: (input) => {
      calls.push({ fn: 'openDocument', input });
      return Promise.resolve(delivery);
    },
  };
  return { port: adaptPrescriptionModule(module), calls };
}

describe('the list', () => {
  it('shows each prescription with where it stands, and offers the document for every one that has it', async () => {
    const { port } = moduleOf(
      [
        { id: ID, issuedAt: '2031-05-18T14:00:00.000Z', status: 'issued' },
        { id: 'other', issuedAt: '2031-04-18T14:00:00.000Z', status: 'cancelled' },
      ],
      null,
    );

    expect(await port.list(TX, CALL)).toEqual([
      {
        id: ID,
        issuedAt: '2031-05-18T14:00:00.000Z',
        status: 'issued',
        prescriberName: null,
        hasDocument: true,
      },
      {
        id: 'other',
        issuedAt: '2031-04-18T14:00:00.000Z',
        status: 'cancelled',
        prescriberName: null,
        hasDocument: false,
      },
    ]);
  });

  it('hands the module the subject of the session and the audit actor of the portal', async () => {
    const { port, calls } = moduleOf([], null);

    await port.list(TX, CALL);

    expect(calls).toEqual([
      {
        fn: 'list',
        input: { actor: CALL.actor, patientId: 'patient-1', auditActor: CALL.auditActor },
      },
    ]);
  });
});

describe('the document', () => {
  it('passes the storage object on, with the name the module chose', async () => {
    const { port, calls } = moduleOf([], {
      objectKey: 't/tenant/prescriptions/abc.pdf',
      contentType: 'application/pdf',
      contentDisposition: 'attachment; filename="receta-2031-05-18-00000b01.pdf"',
    });

    const file = await port.document(TX, { ...CALL, prescriptionId: ID });

    expect(file).toEqual({
      objectKey: 't/tenant/prescriptions/abc.pdf',
      contentType: 'application/pdf',
      fileName: 'receta-2031-05-18-00000b01.pdf',
    });
    expect(calls[0]?.input).toEqual({
      actor: CALL.actor,
      patientId: 'patient-1',
      auditActor: CALL.auditActor,
      prescriptionId: ID,
    });
  });

  it('is null when the module has none: not theirs, not confirmed, cancelled or no document', async () => {
    const { port } = moduleOf([], null);

    expect(await port.document(TX, { ...CALL, prescriptionId: ID })).toBeNull();
  });

  it('falls back to a plain name when the header does not carry one', () => {
    expect(fileNameOf('attachment')).toBe('receta.pdf');
    expect(fileNameOf('attachment; filename="a.pdf"')).toBe('a.pdf');
  });
});
