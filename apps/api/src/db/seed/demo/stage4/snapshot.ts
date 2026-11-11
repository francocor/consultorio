import { asc } from 'drizzle-orm';

import { SYSTEM_USER_ID, type WithTenant } from '../../../../platform/db/tenant-context.js';
import { charge, chargeLine } from '../../../schema/billing-charges.js';
import { cashSession, payment, paymentReversal } from '../../../schema/billing-payments.js';
import { payerPlanPrice, price, tenantPayer } from '../../../schema/billing-pricing.js';
import { invoice, invoiceLine } from '../../../schema/invoicing.js';
import { patient } from '../../../schema/patients.js';
import { payer } from '../../../schema/platform-catalogs.js';
import { location } from '../../../schema/tenant.js';

/**
 * The logical content of the Stage 4 part of a demonstration organization: what a person would
 * notice, without ids and timestamps. Two seeds of the same day give equal snapshots.
 */
export interface DemoStage4Snapshot {
  prices: { amount: number; scope: string }[];
  payerPrices: { payer: string; plan: string; payerCents: number; copago: number; plus: number }[];
  charges: {
    patient: string;
    place: string;
    status: string;
    needsReview: boolean;
    lines: string[];
    payments: string[];
    invoiced: number;
  }[];
  registers: {
    place: string;
    status: string;
    opening: number;
    expected: number | null;
    counted: number | null;
    difference: number | null;
  }[];
  invoices: {
    type: string;
    status: string;
    number: number | null;
    total: number;
    recipient: string;
    creditNote: boolean;
    lines: number;
  }[];
}

export async function snapshotDemoStage4(
  withTenant: WithTenant,
  tenantId: string,
): Promise<DemoStage4Snapshot> {
  return withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const people = new Map(
      (await tx.select().from(patient)).map((row) => [
        row.id,
        `${row.familyName}, ${row.givenNames}`,
      ]),
    );
    const places = new Map((await tx.select().from(location)).map((row) => [row.id, row.name]));
    const catalog = new Map((await tx.select().from(payer)).map((row) => [row.id, row.code]));
    const payers = new Map(
      (await tx.select().from(tenantPayer)).map((row) => [
        row.id,
        row.customName ?? catalog.get(row.payerId ?? '') ?? '?',
      ]),
    );
    const sorted = <T>(rows: T[], key: (row: T) => string) =>
      [...rows].sort((a, b) => key(a).localeCompare(key(b)));

    const lines = await tx.select().from(chargeLine).orderBy(asc(chargeLine.position));
    const payments = await tx.select().from(payment);
    const reversals = await tx.select().from(paymentReversal);
    const invoiceLines = await tx.select().from(invoiceLine);

    return {
      prices: sorted(
        (await tx.select().from(price)).map((row) => ({
          amount: row.amountCents,
          scope: `${row.effectiveFrom}|${row.professionalId === null ? 'general' : 'professional'}`,
        })),
        (row) => `${row.scope}|${String(row.amount).padStart(12, '0')}`,
      ),
      payerPrices: sorted(
        (await tx.select().from(payerPlanPrice)).map((row) => ({
          payer: payers.get(row.tenantPayerId) ?? '?',
          plan: row.planName ?? 'all',
          payerCents: row.payerAmountCents,
          copago: row.copagoCents,
          plus: row.plusCents,
        })),
        (row) => `${row.payer}|${row.plan}|${String(row.payerCents).padStart(12, '0')}`,
      ),
      charges: sorted(
        (await tx.select().from(charge)).map((row) => ({
          patient: people.get(row.patientId) ?? '?',
          place: places.get(row.locationId) ?? '?',
          status: row.status,
          needsReview: row.needsReview,
          lines: lines
            .filter((line) => line.chargeId === row.id)
            .map((line) => `${line.kind}:${line.portion}:${String(line.amountCents)}`),
          payments: payments
            .filter((entry) => entry.chargeId === row.id)
            .map((entry) => {
              const taken = reversals
                .filter((reversal) => reversal.paymentId === entry.id)
                .reduce((sum, reversal) => sum + reversal.amountCents, 0);
              return `${entry.method}:${String(entry.amountCents)}:${String(taken)}`;
            })
            .sort(),
          invoiced: lines
            .filter((line) => line.chargeId === row.id)
            .reduce((sum, line) => sum + line.invoicedCents, 0),
        })),
        (row) =>
          `${row.patient}|${row.place}|${row.lines.join(',')}|${row.payments.join(',')}|${row.status}|${String(row.needsReview)}`,
      ),
      registers: sorted(
        (await tx.select().from(cashSession)).map((row) => ({
          place: places.get(row.locationId) ?? '?',
          status: row.status,
          opening: row.openingCents,
          expected: row.expectedCents,
          counted: row.countedCents,
          difference: row.differenceCents,
        })),
        (row) =>
          `${row.place}|${row.status}|${String(row.opening)}|${String(row.expected)}|${String(row.counted)}`,
      ),
      invoices: sorted(
        (await tx.select().from(invoice)).map((row) => ({
          type: row.type,
          status: row.status,
          number: row.number,
          total: row.totalCents,
          recipient:
            row.patientId === null
              ? (payers.get(row.tenantPayerId ?? '') ?? '?')
              : (people.get(row.patientId) ?? '?'),
          creditNote: row.creditNoteOfId !== null,
          lines: invoiceLines.filter((line) => line.invoiceId === row.id).length,
        })),
        (row) =>
          `${row.type}|${row.status}|${String(row.number ?? 0).padStart(8, '0')}|${row.recipient}|${String(row.total)}`,
      ),
    };
  });
}
