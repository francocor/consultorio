import type { PrescriptionRequest } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { describePrescriptionProviderContract } from '../prescription-provider.contract.js';

import { createFakePrescriptionProvider } from './index.js';

describePrescriptionProviderContract({
  name: 'in-memory fake',
  make: () => {
    const provider = createFakePrescriptionProvider();
    return Promise.resolve({
      provider,
      setMode: (mode) => {
        provider.setMode(mode);
        return Promise.resolve();
      },
      advance: (externalId, to) => {
        provider.advance(externalId, to);
        return Promise.resolve();
      },
    });
  },
});

const request = (overrides: Partial<PrescriptionRequest> = {}): PrescriptionRequest => ({
  matricula: { jurisdiction: 'AR-B', number: 'MP 12345' },
  patientDocument: { type: 'dni', number: '30123456' },
  items: ['Amoxicilina 500 mg, comprimidos, 1 cada 8 horas durante 7 dias, 21 comprimidos'],
  ...overrides,
});

describe('the in-memory prescription provider (task 5.1)', () => {
  it('marks itself as a simulator, so every screen says "simulated"', () => {
    expect(createFakePrescriptionProvider().simulated).toBe(true);
  });

  it('gives the same external id for the same key in any instance (deterministic, for the demo and golden tests)', async () => {
    const first = await createFakePrescriptionProvider().issue(request(), 'key-a');
    const second = await createFakePrescriptionProvider().issue(request(), 'key-a');
    const other = await createFakePrescriptionProvider().issue(request(), 'key-b');

    expect(first.status).toBe('issued');
    expect(second).toEqual(first);
    expect(other).not.toEqual(first);
  });

  it('points the document at an address that says it is simulated', async () => {
    const result = await createFakePrescriptionProvider().issue(request(), 'key-a');

    if (result.status !== 'issued') throw new Error('not issued');
    expect(result.documentUrl).toMatch(/^fake-erx:\/\/prescription\/ERX-[0-9A-F]{12}$/);
  });

  it('forgets everything on reset: the keys are free again and the mode goes back to ok', async () => {
    const provider = createFakePrescriptionProvider();
    const before = await provider.issue(request(), 'key-a');
    provider.setMode('down');

    provider.reset();

    expect(provider.mode()).toBe('ok');
    expect(provider.prescriptions()).toEqual([]);
    expect(await provider.findByKey('key-a')).toBeNull();
    expect(await provider.issue(request(), 'key-a')).toEqual(before);
  });

  it('lists what it issued, oldest first, with the state of each', async () => {
    const provider = createFakePrescriptionProvider();
    const first = await provider.issue(request(), 'key-a');
    const second = await provider.issue(request(), 'key-b');
    if (first.status !== 'issued' || second.status !== 'issued') throw new Error('not issued');
    provider.advance(first.externalId, 'dispensed');

    expect(
      provider.prescriptions().map((prescription) => [prescription.externalId, prescription.state]),
    ).toEqual([
      [first.externalId, 'dispensed'],
      [second.externalId, 'issued'],
    ]);
  });

  it('does not move a cancelled prescription to dispensed', async () => {
    const provider = createFakePrescriptionProvider();
    const issued = await provider.issue(request(), 'key-a');
    if (issued.status !== 'issued') throw new Error('not issued');
    await provider.cancel(issued.externalId, 'Error', 'cancel-a');

    provider.advance(issued.externalId, 'dispensed');

    expect(await provider.status(issued.externalId)).toMatchObject({ state: 'cancelled' });
  });
});
