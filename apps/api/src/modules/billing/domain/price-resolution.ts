import { money } from '@consultorio/contracts';

/**
 * Price resolution (billing-payments, "Price catalog per organization", "Payer and plan catalog
 * with coverage pricing"). Pure: the same prices, payer and appointment always give the same quote,
 * whatever the order of the lists. Amounts are whole cents (`*Cents`); `money()` refuses anything
 * that is not a whole number, so a float cannot get through.
 *
 * Order of the answer:
 * 1. the payer plan of the patient, when the payer is active and has a price for the type: what
 *    the payer covers (payer portion, tracked as a receivable) and the patient's copago and plus
 *    (patient portion, each as a line of its own);
 * 2. the private price: the most specific scope wins (professional, then specialty, then
 *    location, then general), and inside a scope the latest `effectiveFrom` that is not in the
 *    future;
 * 3. nothing: `no_price`. The system never invents a zero.
 */

/** A private price of the catalog, as the resolution reads it. */
export interface PriceRule {
  id: string;
  appointmentTypeId: string;
  professionalId: string | null;
  specialty: string | null;
  locationId: string | null;
  amountCents: number;
  /** `YYYY-MM-DD`. */
  effectiveFrom: string;
  active: boolean;
}

/** What a payer plan pays and the patient adds for one type. */
export interface PayerPriceRule {
  id: string;
  tenantPayerId: string;
  /** Null: every plan of the payer. */
  planName: string | null;
  appointmentTypeId: string;
  payerAmountCents: number;
  copagoCents: number;
  plusCents: number;
  effectiveFrom: string;
  active: boolean;
}

/** The appointment the quote is for. */
export interface PriceContext {
  appointmentTypeId: string;
  professionalId: string;
  /** The disciplines of the professional (`professional.specialties`). */
  professionalSpecialties: readonly string[];
  locationId: string;
  /** The day the service is given, in the time zone of the location (`YYYY-MM-DD`). */
  onDate: string;
}

/** The payer the patient is covered by, once matched with the payers of the organization. */
export interface PayerChoice {
  tenantPayerId: string;
  planName: string | null;
  /** A deactivated payer is not offered for new charges. */
  active: boolean;
}

export type QuoteLineKind = 'service' | 'payer_coverage' | 'copago' | 'plus';

export interface QuoteLine {
  kind: QuoteLineKind;
  portion: 'patient' | 'payer';
  amountCents: number;
}

/**
 * Why a private price was used for a patient who has a payer: the payer was deactivated, has no
 * price for the type, or is not in the organization's list of payers (the last one is added by
 * the service that matches the coverage with the list).
 */
export type QuoteNote = 'payer_inactive' | 'payer_without_price' | 'payer_not_listed';

export interface Quote {
  source: 'private' | 'payer';
  /** The private price used (`source: 'private'`). */
  priceId: string | null;
  /** The payer plan price used (`source: 'payer'`). */
  payerPriceId: string | null;
  tenantPayerId: string | null;
  planName: string | null;
  /** The `effectiveFrom` of the price that applied. */
  effectiveFrom: string;
  lines: QuoteLine[];
  totalCents: number;
  patientCents: number;
  payerCents: number;
  notes: QuoteNote[];
}

export type QuoteResult = { ok: true; quote: Quote } | { ok: false; reason: 'no_price' };

export interface ResolveInput {
  context: PriceContext;
  payer: PayerChoice | null;
  prices: readonly PriceRule[];
  payerPrices: readonly PayerPriceRule[];
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The winner by a list of keys, larger first; the id breaks the last tie so the answer is stable. */
function best<T extends { id: string }>(
  candidates: readonly T[],
  keys: (item: T) => readonly (number | string)[],
): T | undefined {
  return [...candidates].sort((a, b) => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i += 1) {
      const x = ka[i] ?? 0;
      const y = kb[i] ?? 0;
      if (x === y) continue;
      return x < y ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

function pickPayerPrice(
  payer: PayerChoice,
  context: PriceContext,
  rules: readonly PayerPriceRule[],
): PayerPriceRule | undefined {
  const planName = payer.planName;
  const matching = rules.filter(
    (rule) =>
      rule.active &&
      rule.tenantPayerId === payer.tenantPayerId &&
      rule.appointmentTypeId === context.appointmentTypeId &&
      rule.effectiveFrom <= context.onDate &&
      (rule.planName === null || (planName !== null && sameText(rule.planName, planName))),
  );
  // The exact plan before the price for every plan, then the latest start.
  return best(matching, (rule) => [rule.planName === null ? 0 : 1, rule.effectiveFrom]);
}

function pickPrivatePrice(
  context: PriceContext,
  rules: readonly PriceRule[],
): PriceRule | undefined {
  const matching = rules.filter(
    (rule) =>
      rule.active &&
      rule.appointmentTypeId === context.appointmentTypeId &&
      rule.effectiveFrom <= context.onDate &&
      (rule.professionalId === null || rule.professionalId === context.professionalId) &&
      (rule.specialty === null ||
        context.professionalSpecialties.some((own) => sameText(own, rule.specialty ?? ''))) &&
      (rule.locationId === null || rule.locationId === context.locationId),
  );
  // Professional, then specialty, then location, then general; then the latest start.
  return best(matching, (rule) => [
    rule.professionalId === null ? 0 : 1,
    rule.specialty === null ? 0 : 1,
    rule.locationId === null ? 0 : 1,
    rule.effectiveFrom,
  ]);
}

function payerQuote(rule: PayerPriceRule, payer: PayerChoice): Quote {
  const candidates: QuoteLine[] = [
    { kind: 'payer_coverage', portion: 'payer', amountCents: money(rule.payerAmountCents) },
    { kind: 'copago', portion: 'patient', amountCents: money(rule.copagoCents) },
    { kind: 'plus', portion: 'patient', amountCents: money(rule.plusCents) },
  ];
  const lines = candidates.filter((line) => line.amountCents > 0);
  const payerCents = money(rule.payerAmountCents);
  const patientCents = money(rule.copagoCents + rule.plusCents);
  return {
    source: 'payer',
    priceId: null,
    payerPriceId: rule.id,
    tenantPayerId: payer.tenantPayerId,
    planName: payer.planName,
    effectiveFrom: rule.effectiveFrom,
    lines,
    totalCents: money(payerCents + patientCents),
    patientCents,
    payerCents,
    notes: [],
  };
}

function privateQuote(rule: PriceRule, notes: QuoteNote[]): Quote {
  const amountCents = money(rule.amountCents);
  return {
    source: 'private',
    priceId: rule.id,
    payerPriceId: null,
    tenantPayerId: null,
    planName: null,
    effectiveFrom: rule.effectiveFrom,
    lines: [{ kind: 'service', portion: 'patient', amountCents }],
    totalCents: amountCents,
    patientCents: amountCents,
    payerCents: 0,
    notes,
  };
}

export function resolvePrice(input: ResolveInput): QuoteResult {
  const { context, payer } = input;
  const notes: QuoteNote[] = [];

  if (payer !== null) {
    if (!payer.active) {
      notes.push('payer_inactive');
    } else {
      const rule = pickPayerPrice(payer, context, input.payerPrices);
      if (rule) return { ok: true, quote: payerQuote(rule, payer) };
      notes.push('payer_without_price');
    }
  }

  const rule = pickPrivatePrice(context, input.prices);
  if (!rule) return { ok: false, reason: 'no_price' };
  return { ok: true, quote: privateQuote(rule, notes) };
}
