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
    list: (tx, input) => {
      expect(tx).toBe(TX);
      calls.push({ fn: 'list', input });
      return Promise.resolve(listed);
    },
    openDocument: (tx, input) => {
      expect(tx).toBe(TX);
      calls.push({ fn: 'openDocument', input });
      return Promise.resolve(delivery);
    },
  };
  return { port: adaptPrescriptionModule(module), calls };
}

describe('the list', () => {
  it('shows each prescription with where it stands, and offers the document only where the module says there is one', async () => {
    const { port } = moduleOf(
      [
        { id: ID, issuedAt: '2031-05-18T14:00:00.000Z', status: 'issued', hasDocument: true },
        {
          id: 'other',
          issuedAt: '2031-04-18T14:00:00.000Z',
          status: 'cancelled',
          hasDocument: false,
        },
        {
          id: 'nobucket',
          issuedAt: '2031-03-18T14:00:00.000Z',
          status: 'issued',
          hasDocument: false,
        },
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
      {
        id: 'nobucket',
        issuedAt: '2031-03-18T14:00:00.000Z',
        status: 'issued',
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
      kind: 'stored',
      delivery: {
        objectKey: 't/tenant/prescriptions/abc.pdf',
        contentType: 'application/pdf',
        contentDisposition: 'attachment; filename="receta-2031-05-18-00000b01.pdf"',
      },
    });

    const file = await port.document(TX, { ...CALL, prescriptionId: ID, purpose: 'download' });

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
      purpose: 'download',
    });
  });

  it('hands over the bytes of a document the module rendered just now, to be streamed and never stored', async () => {
    const bytes = Buffer.from('%PDF-1.7 rendered');
    const { port } = moduleOf([], {
      kind: 'rendered',
      bytes,
      fileName: 'receta-2031-05-18-00000b01.pdf',
      contentType: 'application/pdf',
    });

    const file = await port.document(TX, { ...CALL, prescriptionId: ID, purpose: 'download' });

    expect(file).toEqual({
      bytes,
      fileName: 'receta-2031-05-18-00000b01.pdf',
      contentType: 'application/pdf',
    });
  });

  it('tells the module why it is asked for the document, so only a download is audited', async () => {
    const { port, calls } = moduleOf([], null);

    await port.document(TX, { ...CALL, prescriptionId: ID, purpose: 'link' });
    await port.document(TX, { ...CALL, prescriptionId: ID, purpose: 'download' });

    expect(calls.map((entry) => (entry.input as { purpose?: string }).purpose)).toEqual([
      'link',
      'download',
    ]);
  });

  it('is null when the module has none: not theirs, not confirmed, cancelled or no document', async () => {
    const { port } = moduleOf([], null);

    expect(await port.document(TX, { ...CALL, prescriptionId: ID, purpose: 'link' })).toBeNull();
  });

  it('falls back to a plain name when the header does not carry one', () => {
    expect(fileNameOf('attachment')).toBe('receta.pdf');
    expect(fileNameOf('attachment; filename="a.pdf"')).toBe('a.pdf');
  });
});
