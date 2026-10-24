import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type {
  ErxSimulatorMode,
  PrescriptionCancelResult,
  PrescriptionProvider,
  PrescriptionRequest,
  PrescriptionResult,
  PrescriptionStatusResult,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import {
  localErxControl,
  localErxPrescription,
  localErxRequest,
  type LocalErxPrescriptionRow,
} from '../../db/schema/local-erx.js';
import type { Db } from '../../platform/db/pool.js';
import {
  KEY_REUSED_MESSAGE,
  NOT_CANCELLABLE_MESSAGE,
  SERVICE_DOWN_MESSAGE,
  TIMEOUT_MESSAGE,
  UNKNOWN_PRESCRIPTION_MESSAGE,
  externalIdFor,
  rejectionFor,
  requestFingerprint,
} from '../erx-fake/prescription-rules.js';

import { startsWithGenericName } from './inn-sample.js';

/**
 * The local e-prescription simulator (`ERX_PROVIDER=local`): a working provider that needs no
 * account and no network. It keeps its prescriptions, the answers it gave to each idempotency key
 * and its mode in Postgres, so the API and the worker see the same one. It behaves like the
 * authorized platform where it matters to the product:
 *
 * - the same idempotency key gets the same prescription (or the same rejection) however many times
 *   it arrives, even at the same time, and a different request under a used key is refused;
 * - it refuses what a provider refuses (no medications, an empty line, and a medication that does
 *   not start with a generic name of its catalog) with a message in Spanish, and a rejection
 *   issues nothing;
 * - `findByKey` reconciles: it answers with the prescription a key produced, if there is one;
 * - a prescription moves to dispensed or expired through the console (`advance`), and a cancelled
 *   one stays cancelled;
 * - modes: `ok`, `down` (retryable, nothing issued) and `timeout_after_issue` (issues, then answers
 *   "unknown outcome"; fires once);
 * - it signs the notices it sends (`signNotice`) and verifies the ones that arrive (`verifyWebhook`)
 *   with the webhook secret: the HMAC covers the time the notice was signed and the raw body
 *   (`<timestamp>.<body>`), and a notice older (or newer) than five minutes is refused, so a notice
 *   captured once cannot be replayed later (JD-S5 R1-B-T3). The headers are `x-erx-timestamp`
 *   (unix seconds) and `x-erx-signature` (`sha256=<hex>`).
 *
 * It carries `simulated: true`: the prescriptions module reads it to say "simulated" on every
 * screen and to stamp the document. The address it hands out is `local-erx://...`, which resolves to
 * nothing outside the process.
 */

export interface LocalPrescriptionProvider extends PrescriptionProvider {
  readonly simulated: true;
  /** The signature (`x-erx-signature`) of a notice signed at `timestamp` (unix seconds, as text). */
  signBody(raw: string, timestamp: string): string;
  /** The two headers a notice of this provider carries, signed now. */
  signNotice(raw: string): { 'x-erx-signature': string; 'x-erx-timestamp': string };
  /**
   * Whether a notice really came from this provider and is recent: the HMAC of the time and the
   * raw body, compared in constant time, with the time inside the window of five minutes.
   */
  verifyWebhook(raw: Buffer, headers: IncomingHttpHeaders): boolean;
}

export interface LocalPrescriptionProviderOptions {
  db: Db;
  /** Signs and verifies the notices. At least 32 characters in production; a process secret in development. */
  webhookSecret: string;
  /** The clock the freshness of a notice is judged by. */
  clock?: () => Date;
}

/** How far from now the time of a notice may be, both ways. */
export const WEBHOOK_WINDOW_SECONDS = 300;

/** The message of a medication line the catalog does not know. */
export const NOT_IN_CATALOG_MESSAGE =
  'Una línea de la receta no empieza con un nombre genérico del catálogo.';

/** The address scheme of a document of the simulator: nothing outside the process can resolve it. */
export const LOCAL_DOCUMENT_SCHEME = 'local-erx://prescription/';

const SIGNATURE_HEADER = 'x-erx-signature';
const TIMESTAMP_HEADER = 'x-erx-timestamp';

type Issued = Extract<PrescriptionResult, { status: 'issued' }>;

/** The single control row, created on first use. */
async function readControl(db: Pick<Db, 'insert' | 'select'>) {
  await db.insert(localErxControl).values({ id: 1 }).onConflictDoNothing();
  const [row] = await db.select().from(localErxControl).where(eq(localErxControl.id, 1));
  if (!row) throw new Error('the simulator control row is missing');
  return row;
}

const issuedResult = (prescription: LocalErxPrescriptionRow): Issued => ({
  status: 'issued',
  externalId: prescription.externalId,
  documentUrl: `${LOCAL_DOCUMENT_SCHEME}${prescription.externalId}`,
});

const down = (): { status: 'retryable'; message: string; outcomeUnknown: false } => ({
  status: 'retryable',
  message: SERVICE_DOWN_MESSAGE,
  outcomeUnknown: false,
});

/** The reason the simulator would refuse the request: the shared rules plus its own catalog. */
function localRejectionFor(request: PrescriptionRequest): string | null {
  const shared = rejectionFor(request);
  if (shared !== null) return shared;
  return request.items.every(startsWithGenericName) ? null : NOT_IN_CATALOG_MESSAGE;
}

const cancelFingerprint = (externalId: string, reason: string) =>
  createHash('sha256').update(`cancel|${externalId}|${reason}`).digest('hex');

export function createLocalPrescriptionProvider(
  options: LocalPrescriptionProviderOptions,
): LocalPrescriptionProvider {
  const { db } = options;
  const clock = options.clock ?? (() => new Date());
  const sign = (raw: string, timestamp: string) =>
    `sha256=${createHmac('sha256', options.webhookSecret).update(`${timestamp}.${raw}`).digest('hex')}`;

  /** Consumes a one-shot mode: true for the one request that finds it still set. */
  async function fire(tx: Pick<Db, 'update'>, mode: ErxSimulatorMode): Promise<boolean> {
    const fired = await tx
      .update(localErxControl)
      .set({ mode: 'ok' })
      .where(and(eq(localErxControl.id, 1), eq(localErxControl.mode, mode)))
      .returning({ id: localErxControl.id });
    return fired.length > 0;
  }

  /** The same key never runs twice at once: the second waits for the first and then reads its answer. */
  const keyLock = (tx: Pick<Db, 'execute'>, epoch: number, idempotencyKey: string) =>
    tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`erx-key|${String(epoch)}|${idempotencyKey}`}, 0))`,
    );

  return {
    simulated: true,

    signBody: sign,

    signNotice(raw) {
      const timestamp = String(Math.floor(clock().getTime() / 1000));
      return { 'x-erx-signature': sign(raw, timestamp), 'x-erx-timestamp': timestamp };
    },

    verifyWebhook(raw, headers) {
      const sent = headers[SIGNATURE_HEADER];
      const stamped = headers[TIMESTAMP_HEADER];
      if (typeof sent !== 'string' || typeof stamped !== 'string') return false;
      // A whole number of seconds, inside the window: a stale or future notice is a replay.
      if (!/^\d{1,12}$/.test(stamped)) return false;
      const age = Math.floor(clock().getTime() / 1000) - Number(stamped);
      if (Math.abs(age) > WEBHOOK_WINDOW_SECONDS) return false;
      const expected = Buffer.from(sign(raw.toString('utf8'), stamped));
      const received = Buffer.from(sent);
      return expected.length === received.length && timingSafeEqual(expected, received);
    },

    async issue(
      request: PrescriptionRequest,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<PrescriptionResult> {
      signal?.throwIfAborted();
      const control = await readControl(db);
      if (control.mode === 'down') return down();

      const { epoch } = control;
      const fingerprint = requestFingerprint(request);
      return db.transaction(async (tx): Promise<PrescriptionResult> => {
        await keyLock(tx, epoch, idempotencyKey);
        // Nobody waits any more: leave nothing behind (the transaction rolls back).
        signal?.throwIfAborted();
        const [known] = await tx
          .select()
          .from(localErxRequest)
          .where(
            and(
              eq(localErxRequest.epoch, epoch),
              eq(localErxRequest.idempotencyKey, idempotencyKey),
            ),
          );
        if (known) {
          if (known.kind !== 'issue' || known.fingerprint !== fingerprint) {
            return { status: 'rejected', message: KEY_REUSED_MESSAGE };
          }
          if (known.outcome === 'rejected') {
            return { status: 'rejected', message: known.message ?? NOT_IN_CATALOG_MESSAGE };
          }
          const [found] = await tx
            .select()
            .from(localErxPrescription)
            .where(eq(localErxPrescription.id, known.prescriptionId ?? ''));
          if (!found) throw new Error('the simulator lost a prescription it had issued');
          return issuedResult(found);
        }

        const rejection = localRejectionFor(request);
        if (rejection !== null) {
          await tx.insert(localErxRequest).values({
            epoch,
            idempotencyKey,
            kind: 'issue',
            fingerprint,
            outcome: 'rejected',
            message: rejection,
          });
          return { status: 'rejected', message: rejection };
        }

        const [created] = await tx
          .insert(localErxPrescription)
          .values({ epoch, externalId: externalIdFor(idempotencyKey), idempotencyKey })
          .returning();
        if (!created) throw new Error('the simulator could not store a prescription');
        await tx.insert(localErxRequest).values({
          epoch,
          idempotencyKey,
          kind: 'issue',
          fingerprint,
          outcome: 'issued',
          prescriptionId: created.id,
        });

        if (control.mode === 'timeout_after_issue' && (await fire(tx, 'timeout_after_issue'))) {
          // The prescription is real and committed; the caller is told it does not know.
          return { status: 'retryable', message: TIMEOUT_MESSAGE, outcomeUnknown: true };
        }
        return issuedResult(created);
      });
    },

    async cancel(externalId, reason, idempotencyKey, signal): Promise<PrescriptionCancelResult> {
      signal?.throwIfAborted();
      const control = await readControl(db);
      if (control.mode === 'down') return down();

      const { epoch } = control;
      const fingerprint = cancelFingerprint(externalId, reason);
      return db.transaction(async (tx): Promise<PrescriptionCancelResult> => {
        await keyLock(tx, epoch, idempotencyKey);
        signal?.throwIfAborted();
        const [known] = await tx
          .select()
          .from(localErxRequest)
          .where(
            and(
              eq(localErxRequest.epoch, epoch),
              eq(localErxRequest.idempotencyKey, idempotencyKey),
            ),
          );
        if (known) {
          if (known.kind !== 'cancel' || known.fingerprint !== fingerprint) {
            return { status: 'rejected', message: KEY_REUSED_MESSAGE };
          }
          return known.outcome === 'cancelled'
            ? { status: 'cancelled', externalId }
            : { status: 'rejected', message: known.message ?? NOT_CANCELLABLE_MESSAGE };
        }

        const [found] = await tx
          .select()
          .from(localErxPrescription)
          .where(
            and(
              eq(localErxPrescription.epoch, epoch),
              eq(localErxPrescription.externalId, externalId),
            ),
          )
          .for('update');
        if (!found || found.state !== 'issued') {
          const message = found ? NOT_CANCELLABLE_MESSAGE : UNKNOWN_PRESCRIPTION_MESSAGE;
          await tx.insert(localErxRequest).values({
            epoch,
            idempotencyKey,
            kind: 'cancel',
            fingerprint,
            outcome: 'rejected',
            message,
          });
          return { status: 'rejected', message };
        }
        await tx
          .update(localErxPrescription)
          .set({ state: 'cancelled', cancelReason: reason })
          .where(eq(localErxPrescription.id, found.id));
        await tx.insert(localErxRequest).values({
          epoch,
          idempotencyKey,
          kind: 'cancel',
          fingerprint,
          outcome: 'cancelled',
          prescriptionId: found.id,
        });
        return { status: 'cancelled', externalId };
      });
    },

    async findByKey(idempotencyKey, signal): Promise<PrescriptionResult | null> {
      signal?.throwIfAborted();
      const control = await readControl(db);
      if (control.mode === 'down') return down();
      const [found] = await db
        .select()
        .from(localErxPrescription)
        .where(
          and(
            eq(localErxPrescription.epoch, control.epoch),
            eq(localErxPrescription.idempotencyKey, idempotencyKey),
          ),
        );
      return found ? issuedResult(found) : null;
    },

    async status(externalId, signal): Promise<PrescriptionStatusResult> {
      signal?.throwIfAborted();
      const control = await readControl(db);
      if (control.mode === 'down') return { status: 'retryable', message: SERVICE_DOWN_MESSAGE };
      const [found] = await db
        .select()
        .from(localErxPrescription)
        .where(
          and(
            eq(localErxPrescription.epoch, control.epoch),
            eq(localErxPrescription.externalId, externalId),
          ),
        );
      if (!found) return { status: 'unknown' };
      return {
        status: 'found',
        externalId,
        state: found.state as 'issued' | 'cancelled' | 'dispensed' | 'expired',
        ...(found.cancelReason === null ? {} : { cancelReason: found.cancelReason }),
      };
    },
  };
}

export interface LocalErxPrescriptionDto {
  externalId: string;
  state: 'issued' | 'cancelled' | 'dispensed' | 'expired';
  createdAt: Date;
}

/** What the provider console does with the simulator. */
export interface LocalErxControls {
  mode(): Promise<ErxSimulatorMode>;
  setMode(mode: ErxSimulatorMode): Promise<void>;
  /** The newest prescriptions of the current epoch first. */
  prescriptions(limit: number): Promise<LocalErxPrescriptionDto[]>;
  /** What a pharmacy or the calendar does to an issued prescription. False when it did not move. */
  advance(externalId: string, to: 'dispensed' | 'expired'): Promise<boolean>;
  /** Forgets the prescriptions and the keys and puts the mode back to `ok`. Nothing is deleted. */
  reset(): Promise<void>;
}

export function createLocalErxControls(db: Db): LocalErxControls {
  return {
    async mode() {
      return (await readControl(db)).mode as ErxSimulatorMode;
    },
    async setMode(mode) {
      await readControl(db);
      await db.update(localErxControl).set({ mode }).where(eq(localErxControl.id, 1));
    },
    async prescriptions(limit) {
      const { epoch } = await readControl(db);
      const rows = await db
        .select()
        .from(localErxPrescription)
        .where(eq(localErxPrescription.epoch, epoch))
        .orderBy(desc(localErxPrescription.createdAt), desc(localErxPrescription.id))
        .limit(limit);
      return rows.map((row) => ({
        externalId: row.externalId,
        state: row.state as LocalErxPrescriptionDto['state'],
        createdAt: row.createdAt,
      }));
    },
    async advance(externalId, to) {
      const { epoch } = await readControl(db);
      const moved = await db
        .update(localErxPrescription)
        .set({ state: to })
        .where(
          and(
            eq(localErxPrescription.epoch, epoch),
            eq(localErxPrescription.externalId, externalId),
            eq(localErxPrescription.state, 'issued'),
          ),
        )
        .returning({ id: localErxPrescription.id });
      return moved.length > 0;
    },
    async reset() {
      await readControl(db);
      await db
        .update(localErxControl)
        .set({ epoch: sql`${localErxControl.epoch} + 1`, mode: 'ok' })
        .where(eq(localErxControl.id, 1));
    },
  };
}
