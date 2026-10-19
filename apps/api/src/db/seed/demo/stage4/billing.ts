import {
  CaptureChargeRequest,
  CashCloseRequest,
  CashOpenRequest,
  CorrectPaymentRequest,
  CreatePayerPriceRequest,
  CreatePriceRequest,
  CreateTenantPayerRequest,
  RecordPaymentRequest,
  RefundPaymentRequest,
  VoidChargeRequest,
  type AppointmentStatus,
} from '@consultorio/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { visibleLocationIds } from '../../../../modules/access/index.js';
import { captureCharge } from '../../../../modules/billing/application/capture-charge.js';
import {
  closeSession,
  currentSession,
  openSession,
} from '../../../../modules/billing/application/cash-register.js';
import { loadCharge } from '../../../../modules/billing/application/charge-view.js';
import { flagChargeForReview } from '../../../../modules/billing/application/flag-charge.js';
import { addPayer, updatePayer } from '../../../../modules/billing/application/payers.js';
import {
  correctPayment,
  recordPayment,
  refundPayment,
} from '../../../../modules/billing/application/payments.js';
import { createPayerPrice, createPrice } from '../../../../modules/billing/application/prices.js';
import { billingScopeOf } from '../../../../modules/billing/application/scope.js';
import { voidCharge } from '../../../../modules/billing/application/void-charge.js';
import { invoiceLookup } from '../../../../modules/invoicing/index.js';
import { localParts } from '../../../../modules/scheduling/domain/time.js';
import type { Tx } from '../../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../../platform/db/uuid.js';
import type { AppointmentEvent } from '../../../../platform/events/appointment-events.js';
import { AppError } from '../../../../platform/http/problem.js';
import { payer } from '../../../schema/platform-catalogs.js';
import { appointmentType } from '../../../schema/scheduling-config.js';
import { appointment } from '../../../schema/scheduling.js';
import { tenant, location } from '../../../schema/tenant.js';

import { planFor, scenarioFor, type PaymentPlan } from './plan.js';
import {
  actorOf,
  addDays,
  contextOf,
  localInstant,
  syntheticCuit,
  viewerOf,
  type Person,
  type Stage4Context,
  type Stage4People,
} from './shared.js';

/**
 * The billing part of the demonstration (tasks 4.63): the price list and the payers of the
 * organization, a charge for every visit of the last days, payments of every method, refunds, a
 * correction, voided charges, and the cash register of each place and day, closed with its count
 * (two of them with a difference) and the one of today still open at every desk. Everything is written through
 * the services the API runs, so the rules (a charge needs a check-in, cash needs an open register,
 * a closed register never changes) are the real ones and the audit trail is real too.
 */

/** Private prices of the appointment types, in cents. The older price is 10% lower. */
const PRIVATE_PRICES: Readonly<Record<string, number>> = {
  'Primera consulta': 4_500_000,
  Control: 3_000_000,
  'Chequeo cardiológico': 6_000_000,
  'Control de niño sano': 3_800_000,
  'Sesión de terapia': 4_000_000,
};

interface PayerPriceSeed {
  type: string;
  planName?: string;
  payerCents: number;
  copagoCents: number;
  plusCents?: number;
}

/**
 * The payers of the organization. OSDE and Swiss Medical have prices and a CUIT (so a Factura goes
 * to them); Galeno has prices and no CUIT yet (the invoicing screen points at the payer settings);
 * PAMI is on the list with no price (visits are charged at the private price, and say why); Medifé
 * was switched off; IOMA was never added.
 */
const PAYERS: readonly {
  code: string;
  cuit: boolean;
  active: boolean;
  prices: readonly PayerPriceSeed[];
}[] = [
  {
    code: 'osde',
    cuit: true,
    active: true,
    prices: [
      { type: 'Primera consulta', payerCents: 3_200_000, copagoCents: 500_000 },
      { type: 'Control', payerCents: 2_300_000, copagoCents: 400_000 },
      { type: 'Control', planName: '310', payerCents: 2_500_000, copagoCents: 250_000 },
      {
        type: 'Chequeo cardiológico',
        payerCents: 4_500_000,
        copagoCents: 600_000,
        plusCents: 300_000,
      },
    ],
  },
  {
    code: 'swiss_medical',
    cuit: true,
    active: true,
    prices: [
      { type: 'Primera consulta', payerCents: 3_000_000, copagoCents: 600_000 },
      { type: 'Control', payerCents: 2_100_000, copagoCents: 500_000 },
      { type: 'Control de niño sano', payerCents: 2_800_000, copagoCents: 300_000 },
    ],
  },
  {
    code: 'galeno',
    cuit: false,
    active: true,
    prices: [
      { type: 'Primera consulta', payerCents: 2_900_000, copagoCents: 700_000 },
      { type: 'Control de niño sano', payerCents: 2_600_000, copagoCents: 400_000 },
    ],
  },
  { code: 'pami', cuit: true, active: true, prices: [] },
  { code: 'medife', cuit: false, active: false, prices: [] },
];

/** The fee of a visit that did not happen, in cents: 5,000 pesos. */
const LATE_FEE_CENTS = 500_000;
const OPENING_CASH_CENTS = 2_000_000;
const COUNT_DIFFERENCES = [
  {
    cents: -150_000,
    reason: 'Faltante de billetes de 500 pesos detectado al contar; se informó a administración',
  },
  { cents: 200_000, reason: 'Sobrante: se dio de menos un vuelto que el paciente después reclamó' },
] as const;

export interface SeededCharge {
  chargeId: string;
  appointmentId: string;
  patientId: string;
  locationId: string;
  professionalId: string;
  /** The day of the service at the place, `YYYY-MM-DD`. */
  day: string;
  startsAt: Date;
  status: 'pending' | 'partially_paid' | 'paid' | 'voided';
  /** What the patient paid, net of refunds. */
  paidCents: number;
  tenantPayerId: string | null;
  lines: { id: string; portion: 'patient' | 'payer'; kind: string; amountCents: number }[];
}

export interface BillingSeed {
  charges: SeededCharge[];
  /** The payers of the organization, by catalog code. */
  payers: Map<string, { id: string; cuit: string | null; active: boolean }>;
  /** The places of the organization, by id. */
  locations: Map<string, { name: string; timeZone: string }>;
}

interface Visit {
  id: string;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  locationId: string;
  timeZone: string;
  professionalId: string;
  appointmentTypeId: string;
  patientId: string;
  typeName: string;
  day: string;
}

const BILLABLE: readonly string[] = [
  'checked_in',
  'in_progress',
  'attended',
  'no_show',
  'cancelled',
];

export async function seedBilling(
  context: Stage4Context,
  people: Stage4People,
): Promise<BillingSeed> {
  const { owner, reception } = people;
  const ownerContext = contextOf(context, owner);
  const { withTenant, now } = context;
  const today = localParts('America/Argentina/Buenos_Aires', now).date;

  // 1. The setup the owner does: the fee for a visit that did not happen, the payers, the prices.
  await withTenant(ownerContext, (tx) =>
    tx
      .update(tenant)
      .set({
        settings: sql`jsonb_set(coalesce(${tenant.settings}, '{}'::jsonb), '{billing}', ${JSON.stringify(
          { lateFeeEnabled: true, lateFeeAmount: LATE_FEE_CENTS },
        )}::jsonb, true)`,
      })
      .where(eq(tenant.id, context.tenantId)),
  );
  const payers = await withTenant(ownerContext, (tx) =>
    setUpPayersAndPrices(tx, context, owner, today),
  );

  // 2. The visits that can be charged, in the order of the day.
  const places = await withTenant(ownerContext, async (tx) => {
    const rows = await tx
      .select({ id: location.id, name: location.name, tz: location.timeZone })
      .from(location);
    return new Map(rows.map((row) => [row.id, { name: row.name, timeZone: row.tz }]));
  });
  const visits = await withTenant(ownerContext, (tx) => loadVisits(tx, context, now));

  // 3. One register per place and day, in order, with everything that happened in it.
  const groups = new Map<string, Visit[]>();
  for (const visit of visits) {
    const key = `${visit.day}|${visit.locationId}`;
    groups.set(key, [...(groups.get(key) ?? []), visit]);
  }
  // Reception works at two of the three places; the administration takes the money at the third.
  const receptionPlaces = await withTenant(ownerContext, (tx) =>
    visibleLocationIds(tx, viewerOf(reception)),
  );
  const charges: SeededCharge[] = [];
  const state = { serial: 0, service: 0, fee: 0, closed: 0, flagged: 0 };
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) ?? [];
    const first = group[0];
    if (!first) continue;
    const isToday = first.day >= localParts(first.timeZone, now).date;
    const desk =
      receptionPlaces === 'all' || receptionPlaces.includes(first.locationId) ? reception : owner;
    const made = await withTenant(contextOf(context, desk), (tx) =>
      runDay(tx, { context, people, desk, group, isToday, state }),
    );
    charges.push(...made);
  }

  // 4. Every desk has opened its register today, with or without visits yet.
  const desks = receptionPlaces === 'all' ? [...places.keys()] : receptionPlaces;
  for (const locationId of desks) {
    const place = places.get(locationId);
    if (!place) continue;
    await withTenant(contextOf(context, reception), async (tx) => {
      const opensAt = new Date(
        Math.min(localInstant(place.timeZone, today, '08:00').getTime(), now.getTime() - 60_000),
      );
      await openSession(tx, {
        request: CashOpenRequest.parse({ locationId, openingCents: OPENING_CASH_CENTS }),
        actor: actorOf(reception),
        viewer: viewerOf(reception),
        now: opensAt,
      });
    });
  }

  // 5. A cash payment of an earlier day was recorded wrong: it is corrected in today's register.
  await withTenant(contextOf(context, reception), (tx) =>
    correctOneCashPayment(tx, { context, people, charges, today }),
  );

  // Charges as they stand after the corrections.
  const final = await withTenant(ownerContext, async (tx) => {
    const scope = await billingScopeOf(tx, viewerOf(owner));
    const result: SeededCharge[] = [];
    for (const made of charges) {
      const dto = await loadCharge(tx, made.chargeId, scope);
      if (!dto) continue;
      result.push({
        ...made,
        status: dto.status,
        paidCents: dto.paidCents,
        tenantPayerId: dto.tenantPayerId,
        lines: dto.lines.map((line) => ({
          id: line.id,
          portion: line.portion,
          kind: line.kind,
          amountCents: line.amountCents,
        })),
      });
    }
    return result;
  });
  return { charges: final, payers, locations: places };
}

async function setUpPayersAndPrices(
  tx: Tx,
  context: Stage4Context,
  owner: Person,
  today: string,
): Promise<BillingSeed['payers']> {
  const actor = actorOf(owner);
  const types = await tx
    .select({ id: appointmentType.id, name: appointmentType.name })
    .from(appointmentType)
    .where(inArray(appointmentType.name, Object.keys(PRIVATE_PRICES)));
  const typeId = (name: string) => {
    const found = types.find((entry) => entry.name === name)?.id;
    if (!found) throw new Error(`The demo has no appointment type "${name}".`);
    return found;
  };

  // The private prices: an older list, and the current one 10% higher from a month ago.
  const older = addDays(today, -120);
  const current = addDays(today, -30);
  for (const [name, cents] of Object.entries(PRIVATE_PRICES)) {
    await createPrice(tx, {
      request: CreatePriceRequest.parse({
        appointmentTypeId: typeId(name),
        amountCents: Math.round((cents * 0.9) / 100) * 100,
        effectiveFrom: older,
      }),
      actor,
    });
    await createPrice(tx, {
      request: CreatePriceRequest.parse({
        appointmentTypeId: typeId(name),
        amountCents: cents,
        effectiveFrom: current,
      }),
      actor,
    });
  }

  const catalog = await tx
    .select({ id: payer.id, code: payer.code })
    .from(payer)
    .where(
      and(
        eq(payer.country, 'AR'),
        inArray(
          payer.code,
          PAYERS.map((entry) => entry.code),
        ),
      ),
    );
  const seeded: BillingSeed['payers'] = new Map();
  let serial = 1;
  for (const entry of PAYERS) {
    const catalogId = catalog.find((row) => row.code === entry.code)?.id;
    if (!catalogId) continue;
    const cuit = entry.cuit ? syntheticCuit(serial) : null;
    serial += 7;
    const created = await addPayer(tx, {
      request: CreateTenantPayerRequest.parse({ payerId: catalogId, ...(cuit ? { cuit } : {}) }),
      country: 'AR',
      actor,
    });
    for (const price of entry.prices) {
      await createPayerPrice(tx, {
        request: CreatePayerPriceRequest.parse({
          tenantPayerId: created.id,
          appointmentTypeId: typeId(price.type),
          ...(price.planName ? { planName: price.planName } : {}),
          payerAmountCents: price.payerCents,
          copagoCents: price.copagoCents,
          plusCents: price.plusCents ?? 0,
          effectiveFrom: current,
        }),
        actor,
      });
    }
    if (!entry.active) {
      await updatePayer(tx, {
        id: created.id,
        request: { active: false },
        country: 'AR',
        actor,
        now: context.now,
      });
    }
    seeded.set(entry.code, { id: created.id, cuit, active: entry.active });
  }
  return seeded;
}

async function loadVisits(tx: Tx, context: Stage4Context, now: Date): Promise<Visit[]> {
  // Seeded order of the agenda: day, time, professional. It does not depend on generated ids.
  const order = [...context.appointments].sort(
    (a, b) =>
      a.entry.date.localeCompare(b.entry.date) ||
      a.entry.startMinute - b.entry.startMinute ||
      a.entry.professional.localeCompare(b.entry.professional),
  );
  const ids = order.map((entry) => entry.id);
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      id: appointment.id,
      status: appointment.status,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      locationId: appointment.locationId,
      timeZone: location.timeZone,
      professionalId: appointment.professionalId,
      appointmentTypeId: appointment.appointmentTypeId,
      patientId: appointment.patientId,
      typeName: appointmentType.name,
    })
    .from(appointment)
    .innerJoin(location, eq(location.id, appointment.locationId))
    .innerJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId))
    .where(inArray(appointment.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visits: Visit[] = [];
  for (const entry of order) {
    const row = byId.get(entry.id);
    if (!row || !BILLABLE.includes(row.status)) continue;
    // A check-in is registered up to a couple of hours before the visit; nothing later is charged.
    if (row.startsAt.getTime() > now.getTime() + 3 * 3_600_000) continue;
    visits.push({
      ...row,
      status: row.status as AppointmentStatus,
      day: localParts(row.timeZone, row.startsAt).date,
    });
  }
  return visits;
}

interface DayState {
  serial: number;
  service: number;
  fee: number;
  closed: number;
  flagged: number;
}

interface DayInput {
  context: Stage4Context;
  people: Stage4People;
  /** Who takes the money at this place. */
  desk: Person;
  group: readonly Visit[];
  isToday: boolean;
  state: DayState;
}

/** The moment a visit's payment is taken: soon after it ends, never in the future. */
function paidAtOf(visit: Visit, now: Date, serial: number): Date {
  const later = visit.endsAt.getTime() + (5 + (serial % 20)) * 60_000;
  return new Date(Math.min(later, now.getTime()));
}

async function runDay(tx: Tx, input: DayInput): Promise<SeededCharge[]> {
  const { context, people, desk, group, isToday, state } = input;
  const { owner } = people;
  const { now } = context;
  const first = group[0];
  if (!first) return [];
  const receptionActor = actorOf(desk);
  const ownerActor = actorOf(owner);
  const receptionViewer = viewerOf(desk);
  const ownerViewer = viewerOf(owner);

  // 1. The charges of the day, and the payments that are taken now.
  interface Planned {
    visit: Visit;
    chargeId: string;
    plan: PaymentPlan;
    paidAt: Date;
    kind: 'service' | 'late_fee';
    lines: SeededCharge['lines'];
    tenantPayerId: string | null;
  }
  const planned: Planned[] = [];
  for (const visit of group) {
    let outcome;
    try {
      outcome = await captureCharge(tx, {
        request: CaptureChargeRequest.parse({ appointmentId: visit.id }),
        actor: receptionActor,
        viewer: receptionViewer,
      });
    } catch (error) {
      // A cancellation made in time, or a visit not checked in: nothing to charge.
      if (
        error instanceof AppError &&
        ['charge_not_billable', 'charge_check_in_required'].includes(error.code)
      ) {
        continue;
      }
      throw error;
    }
    if (!outcome.created) continue;
    const dto = outcome.charge;
    const kind = dto.lines.some((line) => line.kind === 'late_fee') ? 'late_fee' : 'service';
    state.serial += 1;
    const index = kind === 'service' ? state.service++ : state.fee++;
    // A visit that is still going on (or just checked in) has not been paid yet.
    const settled = visit.status === 'attended' || kind === 'late_fee';
    const scenario = settled ? scenarioFor(index, kind) : 'pending';
    const patientCents = dto.patientCents;
    const plan =
      patientCents === 0
        ? { payments: [], refunds: [] }
        : planFor(scenario, { patientCents, serial: state.serial });
    planned.push({
      visit,
      chargeId: dto.id,
      plan,
      paidAt: paidAtOf(visit, now, state.serial),
      kind,
      lines: dto.lines.map((line) => ({
        id: line.id,
        portion: line.portion,
        kind: line.kind,
        amountCents: line.amountCents,
      })),
      tenantPayerId: dto.tenantPayerId,
    });
  }

  // 2. The register of the day opens before the first payment, and holds all of them.
  const payments = planned.filter((entry) => entry.plan.payments.length > 0);
  let registerId: string | null = null;
  if (payments.length > 0 || isToday) {
    const earliest = Math.min(...payments.map((entry) => entry.paidAt.getTime()), now.getTime());
    const opensAt = new Date(
      Math.min(localInstant(first.timeZone, first.day, '07:30').getTime(), earliest - 15 * 60_000),
    );
    const opened = await openSession(tx, {
      request: CashOpenRequest.parse({
        locationId: first.locationId,
        openingCents: OPENING_CASH_CENTS,
      }),
      actor: receptionActor,
      viewer: receptionViewer,
      now: opensAt,
    });
    if (opened.opened) registerId = opened.session.id;
  }

  // 3. Payments, refunds, voids and flags, in the order of the visits.
  for (const entry of planned) {
    const { plan, chargeId, visit } = entry;
    const paymentIds: string[] = [];
    for (const [step, payment] of plan.payments.entries()) {
      const result = await recordPayment(tx, {
        chargeId,
        request: RecordPaymentRequest.parse({
          method: payment.method,
          amountCents: payment.amountCents,
          idempotencyKey: uuidv7(),
          ...(payment.reference ? { externalRef: payment.reference } : {}),
          ...(payment.overrideReason ? { overrideReason: payment.overrideReason } : {}),
          ...(payment.confirmCredit ? { confirmCredit: true } : {}),
        }),
        actor: receptionActor,
        viewer: receptionViewer,
        now: new Date(entry.paidAt.getTime() + step * 60_000),
      });
      paymentIds.push(result.payment.id);
    }
    for (const refund of plan.refunds) {
      const target = paymentIds[refund.paymentIndex];
      if (!target) continue;
      await refundPayment(tx, {
        paymentId: target,
        request: RefundPaymentRequest.parse({
          amountCents: refund.amountCents,
          reason: refund.reason,
          idempotencyKey: uuidv7(),
        }),
        actor: ownerActor,
        viewer: ownerViewer,
        now: new Date(entry.paidAt.getTime() + 30 * 60_000),
      });
    }
    if (plan.void) {
      await voidCharge(tx, {
        chargeId,
        request: VoidChargeRequest.parse({ reason: plan.void }),
        actor: ownerActor,
        viewer: ownerViewer,
        invoices: invoiceLookup,
        now: new Date(entry.paidAt.getTime() + 60 * 60_000),
      });
      continue;
    }
    // A fee that is still owed is also put in front of a person: the visit ended without service.
    if (entry.kind === 'late_fee' && plan.payments.length === 0) {
      state.flagged += 1;
      if (state.flagged % 2 === 1) {
        const facts = {
          appointmentId: visit.id,
          patientId: visit.patientId,
          professionalId: visit.professionalId,
          locationId: visit.locationId,
          appointmentTypeId: visit.appointmentTypeId,
          startsAt: visit.startsAt,
          endsAt: visit.endsAt,
          status: visit.status,
          source: 'staff' as const,
          version: 1,
        };
        // The event as scheduling raises it when the visit ends without service.
        const event: AppointmentEvent =
          visit.status === 'cancelled'
            ? {
                kind: 'cancelled',
                tenantId: context.tenantId,
                appointment: facts,
                fromStatus: 'confirmed',
                cancelledBy: 'patient',
              }
            : {
                kind: 'status_changed',
                tenantId: context.tenantId,
                appointment: facts,
                fromStatus: 'confirmed',
              };
        await flagChargeForReview(tx, event);
      }
    }
  }

  // 4. The day closes with the cash counted, unless it is today: that register stays open.
  if (registerId !== null && !isToday) {
    const current = await currentSession(tx, {
      locationId: first.locationId,
      viewer: receptionViewer,
    });
    if (current) {
      const expected = current.expectedCents;
      state.closed += 1;
      // Two of the closed days do not match the count: one is short, one is over.
      const difference =
        state.closed === 2
          ? COUNT_DIFFERENCES[0]
          : state.closed === 7
            ? COUNT_DIFFERENCES[1]
            : null;
      const last = Math.max(...payments.map((entry) => entry.paidAt.getTime() + 3_600_000), 0);
      const closesAt = new Date(
        Math.max(localInstant(first.timeZone, first.day, '20:00').getTime(), last),
      );
      await closeSession(tx, {
        id: current.id,
        request: CashCloseRequest.parse({
          countedCents: Math.max(0, expected + (difference?.cents ?? 0)),
          ...(difference ? { differenceReason: difference.reason } : {}),
        }),
        actor: receptionActor,
        viewer: receptionViewer,
        now: closesAt,
      });
    }
  }

  return planned.map((entry) => ({
    chargeId: entry.chargeId,
    appointmentId: entry.visit.id,
    patientId: entry.visit.patientId,
    locationId: entry.visit.locationId,
    professionalId: entry.visit.professionalId,
    day: entry.visit.day,
    startsAt: entry.visit.startsAt,
    status: 'pending',
    paidCents: 0,
    tenantPayerId: entry.tenantPayerId,
    lines: entry.lines,
  }));
}

/**
 * The cash payment of the last closed day at a place that has an open register today was typed
 * wrong (the patient handed over less): the correction reverses what was left of it and records
 * the right amount, both in today's register. The closed register is not touched.
 */
async function correctOneCashPayment(
  tx: Tx,
  input: {
    context: Stage4Context;
    people: Stage4People;
    charges: readonly SeededCharge[];
    today: string;
  },
): Promise<void> {
  const { context, people } = input;
  const { owner } = people;
  const open = await tx.execute<{ location_id: string }>(
    sql`SELECT location_id FROM cash_session WHERE status = 'open' ORDER BY opened_at, id`,
  );
  const openAt = new Set(open.rows.map((row) => row.location_id));
  const candidates = await tx.execute<{ id: string; amount_cents: number; charge_id: string }>(
    sql`SELECT p.id, p.amount_cents::int AS amount_cents, p.charge_id
          FROM payment p
          JOIN cash_session s ON s.id = p.cash_session_id AND s.status = 'closed'
         WHERE p.method = 'cash' AND p.amount_cents >= 200000
           AND NOT EXISTS (SELECT 1 FROM payment_reversal r WHERE r.payment_id = p.id)
           AND p.corrects_payment_id IS NULL
         ORDER BY p.paid_at DESC, p.id
         LIMIT 20`,
  );
  const chosen = candidates.rows.find((row) => {
    const made = input.charges.find((entry) => entry.chargeId === row.charge_id);
    return made !== undefined && openAt.has(made.locationId);
  });
  if (!chosen) return;
  await correctPayment(tx, {
    paymentId: chosen.id,
    request: CorrectPaymentRequest.parse({
      amountCents: chosen.amount_cents - 100_000,
      reason: 'El paciente entregó 1.000 pesos menos de lo cargado',
      idempotencyKey: uuidv7(),
    }),
    actor: actorOf(owner),
    viewer: viewerOf(owner),
    now: context.now,
  });
}
