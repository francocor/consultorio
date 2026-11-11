import type { PrescriptionDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { actionsOf, displayState } from './states.js';

const ME = '0190a000-0000-7000-8000-0000000000f1';
const OTHER = '0190a000-0000-7000-8000-0000000000f2';

const prescription = (overrides: Partial<PrescriptionDto> = {}): PrescriptionDto => ({
  id: '0190a000-0000-7000-8000-0000000000c1',
  patientId: '0190a000-0000-7000-8000-0000000000c2',
  encounterId: null,
  status: 'issued',
  date: '2026-10-19',
  createdAt: '2026-10-19T15:00:00.000Z',
  issuedAt: '2026-10-19T15:00:00.000Z',
  externalId: 'ERX-0123456789AB',
  registeredManually: false,
  prescriber: {
    professionalId: ME,
    fullName: 'Dra. Ana Gómez',
    matricula: 'MP 12345',
    jurisdiction: 'AR-B',
    specialty: 'Clínica médica',
  },
  patient: {
    fullName: 'Paula Pérez',
    documentType: 'dni',
    documentNumber: '30123456',
    coverage: null,
  },
  items: [],
  cancelReason: null,
  cancelledAt: null,
  failure: null,
  simulated: false,
  documentAvailable: true,
  ...overrides,
});

const waiting = (overrides: Partial<NonNullable<PrescriptionDto['failure']>> = {}) =>
  prescription({
    status: 'pending_submission',
    externalId: null,
    issuedAt: null,
    documentAvailable: false,
    failure: {
      kind: 'unavailable',
      message: null,
      attempts: 1,
      nextAttemptAt: '2026-10-19T15:01:00.000Z',
      awaitingReconciliation: false,
      ...overrides,
    },
  });

describe('the state of a prescription as the screen tells it', () => {
  it.each([
    ['issued', 'issued'],
    ['dispensed', 'dispensed'],
    ['expired', 'expired'],
    ['cancelled', 'cancelled'],
  ] as const)('shows a %s prescription as %s', (status, expected) => {
    expect(displayState(prescription({ status }))).toBe(expected);
  });

  it('shows one that waits for the provider as pending: never as valid', () => {
    expect(displayState(waiting())).toBe('pending');
  });

  it('shows one that a person has to look at as needing attention', () => {
    expect(displayState(waiting({ kind: 'needs_attention' }))).toBe('attention');
  });

  it('shows one the provider refused as refused', () => {
    expect(
      displayState(
        prescription({
          status: 'draft',
          failure: {
            kind: 'rejected',
            message: 'Una línea de la receta está vacía.',
            attempts: 1,
            nextAttemptAt: null,
            awaitingReconciliation: false,
          },
        }),
      ),
    ).toBe('refused');
  });
});

describe('what the prescriber can do with a prescription', () => {
  it('cancels an issued one and downloads its document, and cannot retry or register it', () => {
    expect(actionsOf(prescription(), ME)).toEqual({
      cancel: true,
      retry: false,
      register: false,
      correct: false,
      download: true,
    });
  });

  it('retries, registers by hand and cancels one that waits for the provider', () => {
    expect(actionsOf(waiting(), ME)).toEqual({
      cancel: true,
      retry: true,
      register: true,
      correct: false,
      download: false,
    });
  });

  it('waits when the provider may have issued it already: no cancelling and no registering by hand', () => {
    const actions = actionsOf(waiting({ awaitingReconciliation: true }), ME);

    expect(actions).toMatchObject({ cancel: false, register: false, retry: true });
  });

  it('corrects a refused one, registers it or cancels it, and cannot retry it as it is', () => {
    const refused = prescription({
      status: 'draft',
      documentAvailable: false,
      failure: {
        kind: 'rejected',
        message: 'Línea vacía',
        attempts: 1,
        nextAttemptAt: null,
        awaitingReconciliation: false,
      },
    });

    expect(actionsOf(refused, ME)).toEqual({
      cancel: true,
      retry: false,
      register: true,
      correct: true,
      download: false,
    });
  });

  it.each(['dispensed', 'expired', 'cancelled'] as const)(
    'can do nothing to a %s prescription but download its document when there is one',
    (status) => {
      expect(actionsOf(prescription({ status, documentAvailable: false }), ME)).toEqual({
        cancel: false,
        retry: false,
        register: false,
        correct: false,
        download: false,
      });
    },
  );

  it('lets a colleague who treats the patient read and download, and nothing else', () => {
    expect(actionsOf(prescription(), OTHER)).toEqual({
      cancel: false,
      retry: false,
      register: false,
      correct: false,
      download: true,
    });
    expect(actionsOf(waiting(), null)).toMatchObject({ cancel: false, retry: false });
  });
});
