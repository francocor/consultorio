import { money, type PriceQuoteResponse, type QuoteDto } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';

import { payerPlanPrice, price, tenantPayer } from '../../../db/schema/billing-pricing.js';
import { payer } from '../../../db/schema/platform-catalogs.js';
import { professional } from '../../../db/schema/staff.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { readPatientPayerPlan } from '../../patients/index.js';
import { readAppointmentForCharge, type AppointmentForCharge } from '../../scheduling/index.js';
import {
  resolvePrice,
  type PayerChoice,
  type Quote,
  type QuoteReason,
} from '../domain/price-resolution.js';

import { localDay } from './common.js';
import { billingScopeOf, canSee, type BillingScope, type ScopeViewer } from './scope.js';

/** Which payer a quote or a charge is made for. */
export type PayerSelection =
  /** The coverage of the patient on the day of the appointment (the default). */
  | { kind: 'coverage' }
  /** The private price, whatever coverage the patient has. */
  | { kind: 'private' }
  /** A payer of the organization's list, chosen by hand. */
  | { kind: 'payer'; tenantPayerId: string; planName: string | null };

export function selectionOf(input: { payer?: string | undefined; planName?: string | undefined }) {
  if (input.payer === undefined) return { kind: 'coverage' } as const;
  if (input.payer === 'private') return { kind: 'private' } as const;
  return { kind: 'payer', tenantPayerId: input.payer, planName: input.planName ?? null } as const;
}

interface ListedPayer {
  id: string;
  name: string;
  active: boolean;
  payerId: string | null;
  customName: string | null;
}

async function listedPayers(tx: Tx): Promise<ListedPayer[]> {
  const rows = await tx
    .select({
      id: tenantPayer.id,
      active: tenantPayer.active,
      payerId: tenantPayer.payerId,
      customName: tenantPayer.customName,
      catalogName: payer.name,
    })
    .from(tenantPayer)
    .leftJoin(payer, eq(payer.id, tenantPayer.payerId));
  return rows.map((row) => ({
    id: row.id,
    active: row.active,
    payerId: row.payerId,
    customName: row.customName,
    name: row.catalogName ?? row.customName ?? '',
  }));
}

interface ChosenPayer {
  listed: ListedPayer;
  planName: string | null;
}

/** The payer of the list the selection means, if any; `missing` when a coverage names one that is not listed. */
async function choosePayer(
  tx: Tx,
  appointment: AppointmentForCharge,
  onDate: string,
  selection: PayerSelection,
): Promise<{ chosen: ChosenPayer | null; notListed: boolean }> {
  if (selection.kind === 'private') return { chosen: null, notListed: false };
  const payers = await listedPayers(tx);

  if (selection.kind === 'payer') {
    const listed = payers.find((candidate) => candidate.id === selection.tenantPayerId);
    if (!listed) throw new AppError('not_found');
    return { chosen: { listed, planName: selection.planName }, notListed: false };
  }

  const coverage = await readPatientPayerPlan(tx, appointment.patientId, onDate);
  // "Particular" is a patient who pays for themselves: the private price, with nothing to explain.
  if (!coverage || coverage.payerKind === 'private') return { chosen: null, notListed: false };
  const listed = payers.find((candidate) =>
    coverage.payerId !== null
      ? candidate.payerId === coverage.payerId
      : candidate.customName?.toLowerCase() === coverage.customName?.toLowerCase(),
  );
  return listed
    ? { chosen: { listed, planName: coverage.planName }, notListed: false }
    : { chosen: null, notListed: true };
}

export interface ResolvedQuote {
  appointment: AppointmentForCharge;
  /** The quote, or `null` when no price matches. */
  quote: QuoteDto | null;
}

function toQuoteDto(
  quote: Quote,
  chosen: ChosenPayer | null,
  extraReasons: readonly QuoteReason[],
): QuoteDto {
  return {
    source: quote.source,
    priceId: quote.priceId,
    payerPriceId: quote.payerPriceId,
    payer:
      quote.source === 'payer' && chosen
        ? { tenantPayerId: chosen.listed.id, name: chosen.listed.name, planName: chosen.planName }
        : null,
    effectiveFrom: quote.effectiveFrom,
    lines: quote.lines.map((line) => ({ ...line, amountCents: money(line.amountCents) })),
    totalCents: money(quote.totalCents),
    patientCents: money(quote.patientCents),
    payerCents: money(quote.payerCents),
    reasons: [...quote.reasons, ...extraReasons],
  };
}

/**
 * The price of an appointment: the same function answers the quote the desk shows and the capture
 * that stores it, so what was quoted is what is charged. Pure reads, no side effect.
 */
export async function resolveQuote(
  tx: Tx,
  appointment: AppointmentForCharge,
  selection: PayerSelection,
): Promise<ResolvedQuote> {
  const onDate = localDay(appointment.startsAt, appointment.locationTimeZone);
  const { chosen, notListed } = await choosePayer(tx, appointment, onDate, selection);

  const [prices, payerPrices, [owner]] = await Promise.all([
    tx.select().from(price).where(eq(price.appointmentTypeId, appointment.appointmentTypeId)),
    chosen
      ? tx
          .select()
          .from(payerPlanPrice)
          .where(
            and(
              eq(payerPlanPrice.tenantPayerId, chosen.listed.id),
              eq(payerPlanPrice.appointmentTypeId, appointment.appointmentTypeId),
            ),
          )
      : Promise.resolve([]),
    tx
      .select({ specialties: professional.specialties })
      .from(professional)
      .where(eq(professional.id, appointment.professionalId)),
  ]);

  const payerChoice: PayerChoice | null = chosen
    ? { tenantPayerId: chosen.listed.id, planName: chosen.planName, active: chosen.listed.active }
    : null;
  const result = resolvePrice({
    context: {
      appointmentTypeId: appointment.appointmentTypeId,
      professionalId: appointment.professionalId,
      professionalSpecialties: owner?.specialties ?? [],
      locationId: appointment.locationId,
      onDate,
    },
    payer: payerChoice,
    prices,
    payerPrices,
  });
  if (!result.ok) return { appointment, quote: null };
  return {
    appointment,
    quote: toQuoteDto(result.quote, chosen, notListed ? ['payer_not_listed'] : []),
  };
}

/** Reads the appointment of a request and checks that the viewer may see it; else not found. */
export async function visibleAppointment(
  tx: Tx,
  appointmentId: string,
  scope: BillingScope,
): Promise<AppointmentForCharge> {
  const found = await readAppointmentForCharge(tx, appointmentId);
  if (!found || !canSee(scope, found)) throw new AppError('not_found');
  return found;
}

/** `GET /billing/price-quote`: what the appointment would be charged, with no side effect. */
export async function quoteAppointment(
  tx: Tx,
  input: { appointmentId: string; selection: PayerSelection; viewer: ScopeViewer },
): Promise<PriceQuoteResponse> {
  const scope = await billingScopeOf(tx, input.viewer);
  const appointment = await visibleAppointment(tx, input.appointmentId, scope);
  const resolved = await resolveQuote(tx, appointment, input.selection);
  return {
    appointmentId: appointment.id,
    appointmentTypeName: appointment.appointmentTypeName,
    quote: resolved.quote,
  };
}
