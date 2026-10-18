import type {
  AfipSimulatorMode,
  InvoiceIssuer,
  InvoiceRef,
  InvoiceRequest,
  IssueResult,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import {
  localAfipControl,
  localAfipRequest,
  localAfipVoucher,
  type LocalAfipVoucherRow,
} from '../../db/schema/local-afip.js';
import type { Db } from '../../platform/db/pool.js';

import {
  DEFAULT_SLOW_MS,
  KEY_REUSED_MESSAGE,
  SERVICE_DOWN_MESSAGE,
  SIMULATED_REJECTION_MESSAGE,
  TIMEOUT_MESSAGE,
  caeExpiresOn,
  caeFor,
  rejectionFor,
  requestFingerprint,
} from './voucher-rules.js';

/**
 * The local AFIP simulator (`AFIP_PROVIDER=local`): a working invoice issuer that needs no
 * certificate and no network. It keeps its vouchers, the answers it gave to each idempotency key
 * and its mode in Postgres, so the API and the worker see the same one. It behaves like the
 * authority where it matters to the product:
 *
 * - numbers are sequential per issuer CUIT, point of sale and voucher type, with no gaps even when
 *   requests arrive together;
 * - the same idempotency key gets the same voucher (or the same rejection) however many times it
 *   arrives, and a different request under a used key is refused;
 * - it refuses what AFIP refuses (bad buyer CUIT, a total that is not the sum of its parts, a
 *   Factura A with no CUIT) with a message in AFIP's style, and a rejection consumes no number;
 * - the CAE has 14 digits and ends 10 days after the date of the voucher;
 * - `findIssued` reconciles: it answers with the voucher of a number, if there is one;
 * - modes: `ok`, `down` (retryable, nothing issued), `slow` (answers late), `timeout_after_authorize`
 *   (authorizes, then answers "unknown outcome"; fires once) and `reject_next` (fires once).
 */

export interface LocalInvoiceIssuer extends InvoiceIssuer {
  readonly simulated: true;
}

export interface LocalInvoiceIssuerOptions {
  db: Db;
  /** How long the `slow` mode keeps a request waiting. */
  slowMs?: number;
}

type Decided = Extract<IssueResult, { status: 'issued' | 'rejected' }>;

/** The single control row, created on first use. */
async function readControl(db: Pick<Db, 'insert' | 'select'>) {
  await db.insert(localAfipControl).values({ id: 1 }).onConflictDoNothing();
  const [row] = await db.select().from(localAfipControl).where(eq(localAfipControl.id, 1));
  if (!row) throw new Error('the simulator control row is missing');
  return row;
}

const issuedResult = (voucher: LocalAfipVoucherRow): Decided => ({
  status: 'issued',
  number: voucher.number,
  cae: voucher.cae,
  caeExpiresOn: voucher.caeExpiresOn,
});

const lock = (name: string) => sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`;

export function createLocalInvoiceIssuer(options: LocalInvoiceIssuerOptions): LocalInvoiceIssuer {
  const { db } = options;
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;

  /** Consumes a one-shot mode: true for the one request that finds it still set. */
  async function fire(tx: Pick<Db, 'update'>, mode: AfipSimulatorMode): Promise<boolean> {
    const fired = await tx
      .update(localAfipControl)
      .set({ mode: 'ok' })
      .where(and(eq(localAfipControl.id, 1), eq(localAfipControl.mode, mode)))
      .returning({ id: localAfipControl.id });
    return fired.length > 0;
  }

  return {
    simulated: true,

    async issue(request: InvoiceRequest, idempotencyKey: string): Promise<IssueResult> {
      const control = await readControl(db);
      if (control.mode === 'down') {
        return { status: 'retryable', message: SERVICE_DOWN_MESSAGE, outcomeUnknown: false };
      }
      if (control.mode === 'slow') await new Promise((resolve) => setTimeout(resolve, slowMs));

      const { epoch } = control;
      const fingerprint = requestFingerprint(request);

      return db.transaction(async (tx): Promise<IssueResult> => {
        // The same key never runs twice at once: the second waits and then reads the first's answer.
        await tx.execute(lock(`afip-key|${String(epoch)}|${idempotencyKey}`));
        const [known] = await tx
          .select()
          .from(localAfipRequest)
          .where(
            and(
              eq(localAfipRequest.epoch, epoch),
              eq(localAfipRequest.idempotencyKey, idempotencyKey),
            ),
          );
        if (known) {
          if (known.fingerprint !== fingerprint) {
            return { status: 'rejected', message: KEY_REUSED_MESSAGE };
          }
          if (known.outcome === 'rejected') {
            return { status: 'rejected', message: known.message ?? SIMULATED_REJECTION_MESSAGE };
          }
          const [voucher] = await tx
            .select()
            .from(localAfipVoucher)
            .where(eq(localAfipVoucher.id, known.voucherId ?? ''));
          if (!voucher) throw new Error('the simulator lost a voucher it had authorized');
          return issuedResult(voucher);
        }

        const rejectNext = control.mode === 'reject_next' && (await fire(tx, 'reject_next'));
        const rejection = rejectNext ? SIMULATED_REJECTION_MESSAGE : rejectionFor(request);
        if (rejection !== null) {
          await tx.insert(localAfipRequest).values({
            epoch,
            idempotencyKey,
            fingerprint,
            outcome: 'rejected',
            message: rejection,
          });
          return { status: 'rejected', message: rejection };
        }

        const issuerCuit = request.issuerCuit ?? '';
        await tx.execute(
          lock(
            `afip-series|${String(epoch)}|${issuerCuit}|${String(request.pointOfSale)}|${request.type}`,
          ),
        );
        const [last] = await tx
          .select({ highest: sql<number>`coalesce(max(${localAfipVoucher.number}), 0)::int` })
          .from(localAfipVoucher)
          .where(
            and(
              eq(localAfipVoucher.epoch, epoch),
              eq(localAfipVoucher.issuerCuit, issuerCuit),
              eq(localAfipVoucher.pointOfSale, request.pointOfSale),
              eq(localAfipVoucher.type, request.type),
            ),
          );
        // After what the simulator holds and after what the organization says it holds: a reset of
        // the simulator starts its numbering again, and the vouchers of the organization stay.
        const number = Math.max(last?.highest ?? 0, request.lastKnownNumber ?? 0) + 1;
        const [voucher] = await tx
          .insert(localAfipVoucher)
          .values({
            epoch,
            issuerCuit,
            pointOfSale: request.pointOfSale,
            type: request.type,
            number,
            cae: caeFor({
              issuerCuit,
              pointOfSale: request.pointOfSale,
              type: request.type,
              number,
            }),
            caeExpiresOn: caeExpiresOn(request.issueDate),
            issueDate: request.issueDate,
            totalCents: request.totalCents,
            idempotencyKey,
          })
          .returning();
        if (!voucher) throw new Error('the simulator could not store a voucher');
        await tx.insert(localAfipRequest).values({
          epoch,
          idempotencyKey,
          fingerprint,
          outcome: 'authorized',
          voucherId: voucher.id,
        });

        if (
          control.mode === 'timeout_after_authorize' &&
          (await fire(tx, 'timeout_after_authorize'))
        ) {
          // The voucher is real and committed; the caller is told it does not know.
          return { status: 'retryable', message: TIMEOUT_MESSAGE, outcomeUnknown: true };
        }
        return issuedResult(voucher);
      });
    },

    async findIssued(ref: InvoiceRef): Promise<IssueResult | null> {
      const control = await readControl(db);
      if (control.mode === 'down') {
        return { status: 'retryable', message: SERVICE_DOWN_MESSAGE, outcomeUnknown: false };
      }
      const [voucher] = await db
        .select()
        .from(localAfipVoucher)
        .where(
          and(
            eq(localAfipVoucher.epoch, control.epoch),
            eq(localAfipVoucher.issuerCuit, ref.issuerCuit ?? ''),
            eq(localAfipVoucher.pointOfSale, ref.pointOfSale),
            eq(localAfipVoucher.type, ref.type),
            eq(localAfipVoucher.number, ref.number),
          ),
        );
      return voucher ? issuedResult(voucher) : null;
    },
  };
}

export interface LocalAfipVoucherDto {
  id: string;
  issuerCuit: string;
  pointOfSale: number;
  type: string;
  number: number;
  cae: string;
  caeExpiresOn: string;
  issueDate: string;
  totalCents: number;
  createdAt: Date;
}

/** What the provider console does with the simulator. */
export interface LocalAfipControls {
  mode(): Promise<AfipSimulatorMode>;
  setMode(mode: AfipSimulatorMode): Promise<void>;
  /** The newest vouchers of the current epoch first. */
  vouchers(limit: number): Promise<LocalAfipVoucherDto[]>;
  /** Starts numbering again and puts the mode back to `ok`. Nothing is deleted. */
  reset(): Promise<void>;
}

export function createLocalAfipControls(db: Db): LocalAfipControls {
  return {
    async mode() {
      return (await readControl(db)).mode as AfipSimulatorMode;
    },
    async setMode(mode) {
      await readControl(db);
      await db.update(localAfipControl).set({ mode }).where(eq(localAfipControl.id, 1));
    },
    async vouchers(limit) {
      const { epoch } = await readControl(db);
      const rows = await db
        .select()
        .from(localAfipVoucher)
        .where(eq(localAfipVoucher.epoch, epoch))
        .orderBy(desc(localAfipVoucher.createdAt), desc(localAfipVoucher.number))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        issuerCuit: row.issuerCuit,
        pointOfSale: row.pointOfSale,
        type: row.type,
        number: row.number,
        cae: row.cae,
        caeExpiresOn: row.caeExpiresOn,
        issueDate: row.issueDate,
        totalCents: row.totalCents,
        createdAt: row.createdAt,
      }));
    },
    async reset() {
      await readControl(db);
      await db
        .update(localAfipControl)
        .set({ epoch: sql`${localAfipControl.epoch} + 1`, mode: 'ok' })
        .where(eq(localAfipControl.id, 1));
    },
  };
}
