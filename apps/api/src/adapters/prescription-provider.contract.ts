import type {
  ErxSimulatorMode,
  PrescriptionProvider,
  PrescriptionRequest,
  PrescriptionResult,
} from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The contract of the `PrescriptionProvider` port (design section 6, "one shared suite per port").
 * The in-memory fake, the local e-prescription simulator and, later, the adapter of the authorized
 * platform must all pass it: what the prescriptions module relies on is written here once.
 *
 * Idempotency keys are global (the server derives them from the organization and the
 * prescription), so every test works with keys of its own and shares nothing with the others.
 */

export interface PrescriptionProviderContractTarget {
  name: string;
  /**
   * A fresh provider, and the controls of a simulator: the mode it is in, and the move of a
   * prescription to the state a pharmacy or the calendar gives it.
   */
  make(): Promise<{
    provider: PrescriptionProvider;
    setMode: (mode: ErxSimulatorMode) => Promise<void>;
    advance: (externalId: string, to: 'dispensed' | 'expired') => Promise<void>;
    /**
     * Only for a provider that can be slowed down (the fake): holds the next calls to `issue` until
     * `release()` and says when a call is waiting. The suite then proves that a second call with the
     * same key, made while the first one is in flight, never creates a second prescription.
     */
    hold?: () => { release(): void; entered: Promise<void> };
  }>;
}

let keys = 0;
const key = () => `contract-erx-${String(Date.now())}-${String((keys += 1))}`;

function requestFor(overrides: Partial<PrescriptionRequest> = {}): PrescriptionRequest {
  return {
    matricula: { jurisdiction: 'AR-B', number: 'MP 12345' },
    patientDocument: { type: 'dni', number: '30123456' },
    items: ['Amoxicilina 500 mg, comprimidos, 1 cada 8 horas durante 7 dias, 21 comprimidos'],
    ...overrides,
  };
}

function expectIssued(result: PrescriptionResult | null) {
  if (result?.status !== 'issued') {
    throw new Error(`expected an issued prescription, got ${JSON.stringify(result)}`);
  }
  return result;
}

export function describePrescriptionProviderContract(
  target: PrescriptionProviderContractTarget,
): void {
  describe(`PrescriptionProvider contract: ${target.name}`, () => {
    it('issues a prescription with an external id and an address for its document', async () => {
      const { provider } = await target.make();

      const result = expectIssued(await provider.issue(requestFor(), key()));

      expect(result.externalId.length).toBeGreaterThan(5);
      expect(result.documentUrl.length).toBeGreaterThan(5);
    });

    it('gives the same prescription for the same idempotency key, and a new one for a new key', async () => {
      const { provider } = await target.make();
      const idempotencyKey = key();

      const first = await provider.issue(requestFor(), idempotencyKey);
      const again = await provider.issue(requestFor(), idempotencyKey);
      const other = expectIssued(await provider.issue(requestFor(), key()));

      expect(again).toEqual(first);
      expect(other.externalId).not.toBe(expectIssued(first).externalId);
    });

    it('refuses a key that comes back with another prescription', async () => {
      const { provider } = await target.make();
      const idempotencyKey = key();
      expectIssued(await provider.issue(requestFor(), idempotencyKey));

      const result = await provider.issue(
        requestFor({ items: ['Ibuprofeno 400 mg, comprimidos, 1 cada 8 horas, 12 comprimidos'] }),
        idempotencyKey,
      );

      expect(result.status).toBe('rejected');
    });

    it('rejects a prescription without medications, or with a blank line', async () => {
      const { provider } = await target.make();

      expect((await provider.issue(requestFor({ items: [] }), key())).status).toBe('rejected');
      expect((await provider.issue(requestFor({ items: ['   '] }), key())).status).toBe('rejected');
    });

    it('finds the prescription of a key it issued, and nothing for a key it never saw', async () => {
      const { provider } = await target.make();
      const idempotencyKey = key();
      const issued = await provider.issue(requestFor(), idempotencyKey);

      expect(await provider.findByKey(idempotencyKey)).toEqual(issued);
      expect(await provider.findByKey(key())).toBeNull();
    });

    it('reports the state of a prescription it issued, and says it does not know one it did not', async () => {
      const { provider } = await target.make();
      const issued = expectIssued(await provider.issue(requestFor(), key()));

      expect(await provider.status(issued.externalId)).toEqual({
        status: 'found',
        externalId: issued.externalId,
        state: 'issued',
      });
      expect(await provider.status('NOT-A-PRESCRIPTION')).toEqual({ status: 'unknown' });
    });

    it('cancels with a reason, and the state shows it', async () => {
      const { provider } = await target.make();
      const issued = expectIssued(await provider.issue(requestFor(), key()));

      const cancelled = await provider.cancel(issued.externalId, 'Error en la dosis', key());

      expect(cancelled).toEqual({ status: 'cancelled', externalId: issued.externalId });
      expect(await provider.status(issued.externalId)).toEqual({
        status: 'found',
        externalId: issued.externalId,
        state: 'cancelled',
        cancelReason: 'Error en la dosis',
      });
    });

    it('answers the same to a cancellation repeated with the same key', async () => {
      const { provider } = await target.make();
      const issued = expectIssued(await provider.issue(requestFor(), key()));
      const cancelKey = key();

      const first = await provider.cancel(issued.externalId, 'Error en la dosis', cancelKey);
      const again = await provider.cancel(issued.externalId, 'Error en la dosis', cancelKey);

      expect(first.status).toBe('cancelled');
      expect(again).toEqual(first);
    });

    it('refuses to cancel what it does not know, and what a pharmacy already dispensed', async () => {
      const { provider, advance } = await target.make();
      const issued = expectIssued(await provider.issue(requestFor(), key()));
      await advance(issued.externalId, 'dispensed');

      const dispensed = await provider.cancel(issued.externalId, 'Error en la dosis', key());
      const unknown = await provider.cancel('NOT-A-PRESCRIPTION', 'Error en la dosis', key());

      expect(dispensed.status).toBe('rejected');
      expect(unknown.status).toBe('rejected');
      expect(await provider.status(issued.externalId)).toMatchObject({ state: 'dispensed' });
    });

    it('moves a prescription to expired when its time runs out', async () => {
      const { provider, advance } = await target.make();
      const issued = expectIssued(await provider.issue(requestFor(), key()));

      await advance(issued.externalId, 'expired');

      expect(await provider.status(issued.externalId)).toMatchObject({ state: 'expired' });
      expect((await provider.cancel(issued.externalId, 'Tarde', key())).status).toBe('rejected');
    });

    it('asks to try again while it is down, and issues once when it is back with the same key', async () => {
      const { provider, setMode } = await target.make();
      const idempotencyKey = key();
      await setMode('down');

      const outage = await provider.issue(requestFor(), idempotencyKey);
      const lookup = await provider.findByKey(idempotencyKey);
      const state = await provider.status('ANY-ID');
      const cancel = await provider.cancel('ANY-ID', 'Motivo', key());

      expect(outage).toMatchObject({ status: 'retryable', outcomeUnknown: false });
      expect(lookup).toMatchObject({ status: 'retryable' });
      expect(state.status).toBe('retryable');
      expect(cancel).toMatchObject({ status: 'retryable', outcomeUnknown: false });

      await setMode('ok');
      // Nothing was issued during the outage, so the key is free.
      expect(await provider.findByKey(idempotencyKey)).toBeNull();
      const issued = expectIssued(await provider.issue(requestFor(), idempotencyKey));
      expect(expectIssued(await provider.findByKey(idempotencyKey)).externalId).toBe(
        issued.externalId,
      );
    });

    it('never creates two prescriptions for a key that is issued twice at the same time', async () => {
      const { provider } = await target.make();
      const idempotencyKey = key();

      const [first, second] = await Promise.all([
        provider.issue(requestFor(), idempotencyKey),
        provider.issue(requestFor(), idempotencyKey),
      ]);

      expect(expectIssued(second).externalId).toBe(expectIssued(first).externalId);
      expect(expectIssued(await provider.findByKey(idempotencyKey)).externalId).toBe(
        expectIssued(first).externalId,
      );
    });

    it('never creates two prescriptions while the first call for a key is still in flight', async (context) => {
      const { provider, hold } = await target.make();
      // An explicit skip, not a silent pass: a target that cannot be slowed down says so in the report.
      if (!hold) return context.skip('this target cannot hold a call (no hold())');
      const idempotencyKey = key();
      const slow = hold();

      const first = provider.issue(requestFor(), idempotencyKey);
      await slow.entered;
      // The first call is in flight: the retry of an impatient caller arrives now.
      const second = provider.issue(requestFor(), idempotencyKey);
      slow.release();

      const [a, b] = await Promise.all([first, second]);
      expect(expectIssued(b).externalId).toBe(expectIssued(a).externalId);
      expect(expectIssued(await provider.findByKey(idempotencyKey)).externalId).toBe(
        expectIssued(a).externalId,
      );
    });

    it('gives up a call whose signal was aborted before it started, and issues nothing', async () => {
      const { provider } = await target.make();
      const idempotencyKey = key();

      await expect(
        provider.issue(requestFor(), idempotencyKey, AbortSignal.abort()),
      ).rejects.toBeDefined();

      expect(await provider.findByKey(idempotencyKey)).toBeNull();
    });

    it('can lose the answer after it issued: the retry finds one prescription, never two', async () => {
      const { provider, setMode } = await target.make();
      const idempotencyKey = key();
      await setMode('timeout_after_issue');

      const lost = await provider.issue(requestFor(), idempotencyKey);

      expect(lost).toMatchObject({ status: 'retryable', outcomeUnknown: true });
      const found = expectIssued(await provider.findByKey(idempotencyKey));
      const retried = expectIssued(await provider.issue(requestFor(), idempotencyKey));
      expect(retried.externalId).toBe(found.externalId);
      // The mode applied once: the next prescription goes through.
      expectIssued(await provider.issue(requestFor(), key()));
    });
  });
}
