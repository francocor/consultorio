import { describe, expect, it } from 'vitest';

import { AppError } from '../../../platform/http/problem.js';

import {
  adaptConsentModule,
  type ConsentModulePortal,
  type ModuleListItem,
  type ModuleSignRequest,
} from './consent-adapter.js';
import type { PortalCall } from './ports.js';

/**
 * The adapter between the portal and the consent module: what the module answers becomes what the
 * sections show, and a request that is not the subject's is a `null`, never a leak.
 */
const TX = {} as never;
const CALL = {
  actor: { identityId: 'identity-1' },
  subject: { patientId: 'patient-1', relationship: 'self', relation: null },
  auditActor: { actingRole: 'patient', userId: null },
} as unknown as PortalCall;
/** The session of a person who represents the patient, with the relation the organization verified. */
const AS_REPRESENTATIVE = {
  ...CALL,
  subject: { patientId: 'patient-1', relationship: 'representative', relation: 'father' },
} as unknown as PortalCall;
const HASH = 'a'.repeat(64);
const PENDING_ID = '0190a000-0000-7000-8000-000000000a01';
const SIGNED_ID = '0190a000-0000-7000-8000-000000000a02';
const DEVICE_ID = '0190a000-0000-7000-8000-000000000a03';

const item = (overrides: Partial<ModuleListItem>): ModuleListItem => ({
  id: PENDING_ID,
  status: 'pending',
  method: 'portal',
  createdAt: '2031-05-19T12:00:00.000Z',
  expiresAt: '2031-06-02T12:00:00.000Z',
  signedAt: null,
  revokedAt: null,
  title: 'Consentimiento informado',
  canOpen: true,
  ...overrides,
});

const SIGNED = item({
  id: SIGNED_ID,
  status: 'signed',
  signedAt: '2031-05-20T12:00:00.000Z',
  title: null,
});

function moduleOf(items: ModuleListItem[], overrides: Partial<ConsentModulePortal> = {}) {
  const calls: { fn: string; input: unknown }[] = [];
  const refuseForeign = (id: string) => {
    if (!items.some((entry) => entry.id === id)) throw new AppError('not_found');
  };
  const module: ConsentModulePortal = {
    list: (_tx, input) => {
      calls.push({ fn: 'list', input });
      return Promise.resolve(items);
    },
    signingView: (_tx, input) => {
      calls.push({ fn: 'signingView', input });
      refuseForeign(input.requestId);
      return Promise.resolve({
        requiresRepresentative: false,
        version: {
          id: 'version-7',
          title: 'Título de la versión',
          body: 'Texto completo.',
          contentHash: HASH,
        },
      });
    },
    sign: (_tx, input) => {
      calls.push({ fn: 'sign', input });
      refuseForeign(input.requestId);
      return Promise.resolve({ id: input.requestId });
    },
    revoke: (_tx, input) => {
      calls.push({ fn: 'revoke', input });
      refuseForeign(input.requestId);
      return Promise.resolve({ id: input.requestId });
    },
    document: (_tx, input) => {
      calls.push({ fn: 'document', input });
      refuseForeign(input.requestId);
      return Promise.resolve({ bytes: Buffer.from('%PDF'), fileName: 'consentimiento.pdf' });
    },
    ...overrides,
  };
  return { port: adaptConsentModule(module), calls };
}

const sentTo = (calls: { fn: string; input: unknown }[], fn: string) =>
  calls.filter((entry) => entry.fn === fn).map((entry) => entry.input as Record<string, unknown>);

describe('the list', () => {
  it('maps each consent for the screen and hides requests that wait at the practice', async () => {
    const { port } = moduleOf([item({}), SIGNED, item({ id: DEVICE_ID, method: 'in_person' })]);

    const list = await port.list(TX, CALL);

    expect(list.map((entry) => entry.id)).toEqual([PENDING_ID, SIGNED_ID]);
    expect(list[0]).toMatchObject({
      title: 'Consentimiento informado',
      status: 'pending',
      requestedAt: '2031-05-19T12:00:00.000Z',
      expiresAt: '2031-06-02T12:00:00.000Z',
      canSign: true,
      canRevoke: false,
      hasDocument: false,
    });
    // A title the viewer may not read is the neutral label; a signed record can be opened and revoked.
    expect(list[1]).toMatchObject({
      title: 'Consentimiento',
      canSign: false,
      canRevoke: true,
      hasDocument: true,
      expiresAt: null,
    });
  });

  it('asks the module for the subject, never for an id from a request', async () => {
    const { port, calls } = moduleOf([]);

    await port.list(TX, CALL);

    expect(calls).toEqual([{ fn: 'list', input: { actor: CALL.actor, patientId: 'patient-1' } }]);
  });

  it('does not offer a record the viewer cannot open', async () => {
    const { port } = moduleOf([{ ...SIGNED, canOpen: false }]);

    expect((await port.list(TX, CALL))[0]?.hasDocument).toBe(false);
  });

  it('keeps a revoked consent downloadable: the record stays', async () => {
    const { port } = moduleOf([
      { ...SIGNED, status: 'revoked', revokedAt: '2031-05-25T12:00:00.000Z' },
    ]);

    expect(await port.list(TX, CALL)).toMatchObject([
      { status: 'revoked', canRevoke: false, hasDocument: true },
    ]);
  });
});

describe('reading one', () => {
  it('brings the full text of the version while it waits for a signature', async () => {
    const { port } = moduleOf([item({})]);

    expect(await port.read(TX, { ...CALL, consentId: PENDING_ID })).toMatchObject({
      title: 'Título de la versión',
      body: 'Texto completo.',
      contentHash: HASH,
      requiresRepresentative: false,
      canSign: true,
    });
  });

  it('has no text for a consent that is already signed: its record is the document', async () => {
    const { port, calls } = moduleOf([SIGNED]);

    expect(await port.read(TX, { ...CALL, consentId: SIGNED_ID })).toMatchObject({
      body: '',
      contentHash: '',
      canSign: false,
      hasDocument: true,
    });
    expect(calls.map((entry) => entry.fn)).toEqual(['list']);
  });

  it('is null for a consent that is not the subject own', async () => {
    const { port } = moduleOf([item({})]);

    expect(await port.read(TX, { ...CALL, consentId: SIGNED_ID })).toBeNull();
  });
});

describe('signing', () => {
  const REQUEST = {
    accepted: true as const,
    contentHash: HASH,
    signerName: 'Ana Pérez',
    signature: { kind: 'typed' as const, value: 'Ana Pérez' },
  };
  const REPRESENTATIVE_REQUEST = {
    accepted: true as const,
    contentHash: HASH,
    signerName: 'María Pérez',
    signature: { kind: 'drawn' as const, value: 'data:image/png;base64,AAAA' },
    representative: {
      fullName: 'María Pérez',
      nationalId: '20111222',
      relation: 'mother' as const,
    },
  };
  /** The module of a minor: the signature has to be the representative's. */
  const minorModule = (items: ModuleListItem[]) =>
    moduleOf(items, {
      signingView: () =>
        Promise.resolve({
          requiresRepresentative: true,
          version: { id: 'version-7', title: 'T', body: 'B', contentHash: HASH },
        }),
    });

  it('signs against the version the request is bound to, with the typed name as the mark', async () => {
    const { port, calls } = moduleOf([item({})]);

    await port.sign(TX, { ...CALL, consentId: PENDING_ID, request: REQUEST });

    const [sent] = sentTo(calls, 'sign');
    expect(sent?.['request']).toEqual({
      versionId: 'version-7',
      accepted: true,
      signer: 'patient',
      signerName: 'Ana Pérez',
      mark: { kind: 'typed', name: 'Ana Pérez' },
    });
    expect(sent?.['auditActor']).toBe(CALL.auditActor);
  });

  it('sends the drawing as the mark and the representative as the signer of a minor, with the relation of the link', async () => {
    const { port, calls } = minorModule([item({})]);

    await port.sign(TX, {
      ...AS_REPRESENTATIVE,
      consentId: PENDING_ID,
      request: REPRESENTATIVE_REQUEST,
    });

    const [sent] = sentTo(calls, 'sign');
    // The relation is the one the organization verified (the link: father), not the one typed (mother).
    expect(sent?.['request'] as ModuleSignRequest).toEqual({
      versionId: 'version-7',
      accepted: true,
      signer: 'representative',
      signerName: 'María Pérez',
      representative: { name: 'María Pérez', nationalId: '20111222', relation: 'father' },
      mark: { kind: 'drawn', imageDataUrl: 'data:image/png;base64,AAAA' },
    });
  });

  it('decides the signer by the link, not by the body: a representative cannot sign as the patient, nor the patient as a representative (JD-S5 R1-S5-5)', async () => {
    const asAdult = moduleOf([item({})]);
    const asMinor = minorModule([item({})]);

    await expect(
      asAdult.port.sign(TX, {
        ...AS_REPRESENTATIVE,
        consentId: PENDING_ID,
        request: REPRESENTATIVE_REQUEST,
      }),
    ).rejects.toMatchObject({ code: 'consent_signer_not_allowed' });
    await expect(
      asMinor.port.sign(TX, { ...AS_REPRESENTATIVE, consentId: PENDING_ID, request: REQUEST }),
    ).rejects.toMatchObject({ code: 'consent_representative_required' });
    await expect(
      asAdult.port.sign(TX, {
        ...CALL,
        consentId: PENDING_ID,
        request: REPRESENTATIVE_REQUEST,
      }),
    ).rejects.toMatchObject({ code: 'consent_representative_unexpected' });
    expect(sentTo(asAdult.calls, 'sign')).toEqual([]);
    expect(sentTo(asMinor.calls, 'sign')).toEqual([]);
  });

  it('refuses a signature for a text that is not the one of the version (JD-S5 R1-B-S4)', async () => {
    const { port, calls } = moduleOf([item({})]);

    await expect(
      port.sign(TX, {
        ...CALL,
        consentId: PENDING_ID,
        request: { ...REQUEST, contentHash: 'b'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'consent_version_mismatch' });
    expect(sentTo(calls, 'sign')).toEqual([]);
  });

  it('answers the consent as it stands after the module recorded the signature', async () => {
    const { port } = moduleOf([item({})]);

    expect(await port.sign(TX, { ...CALL, consentId: PENDING_ID, request: REQUEST })).toMatchObject(
      { id: PENDING_ID },
    );
  });

  it('is null for a consent that is not the subject own, and signs nothing', async () => {
    const { port, calls } = moduleOf([item({})]);

    expect(await port.sign(TX, { ...CALL, consentId: SIGNED_ID, request: REQUEST })).toBeNull();
    expect(calls.map((entry) => entry.fn)).not.toContain('sign');
  });

  it('lets every other refusal of the module go up as it is', async () => {
    const { port } = moduleOf([item({})], {
      signingView: () => Promise.reject(new AppError('portal_state_conflict')),
    });

    await expect(
      port.sign(TX, { ...CALL, consentId: PENDING_ID, request: REQUEST }),
    ).rejects.toMatchObject({ code: 'portal_state_conflict' });
  });
});

describe('revoking and the document', () => {
  it('revokes with the reason when there is one, and without it when there is not', async () => {
    const { port, calls } = moduleOf([SIGNED]);

    await port.revoke(TX, {
      ...CALL,
      consentId: SIGNED_ID,
      request: { reason: 'Cambié de opinión' },
    });
    await port.revoke(TX, { ...CALL, consentId: SIGNED_ID, request: {} });

    expect(sentTo(calls, 'revoke').map((input) => input['request'])).toEqual([
      { reason: 'Cambié de opinión' },
      {},
    ]);
  });

  it('is null when revoking or downloading what is not the subject own', async () => {
    const { port } = moduleOf([SIGNED]);

    expect(await port.revoke(TX, { ...CALL, consentId: PENDING_ID, request: {} })).toBeNull();
    expect(await port.document(TX, { ...CALL, consentId: PENDING_ID, purpose: 'link' })).toBeNull();
  });

  it('hands the rendered record over as bytes of a PDF', async () => {
    const { port } = moduleOf([SIGNED]);

    const file = await port.document(TX, { ...CALL, consentId: SIGNED_ID, purpose: 'download' });

    expect(file).toEqual({
      bytes: Buffer.from('%PDF'),
      fileName: 'consentimiento.pdf',
      contentType: 'application/pdf',
    });
  });

  it('tells the module why it is asked for the record, so only a download is a read for the trail', async () => {
    const { port, calls } = moduleOf([SIGNED]);

    await port.document(TX, { ...CALL, consentId: SIGNED_ID, purpose: 'link' });
    await port.document(TX, { ...CALL, consentId: SIGNED_ID, purpose: 'download' });

    expect(sentTo(calls, 'document').map((input) => input['purpose'])).toEqual([
      'link',
      'download',
    ]);
  });
});
