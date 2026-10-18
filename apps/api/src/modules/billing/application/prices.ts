import {
  money,
  type CreatePayerPriceRequest,
  type CreatePriceRequest,
  type PayerPriceDto,
  type PriceDto,
  type PriceListResponse,
  type UpdatePayerPriceRequest,
  type UpdatePriceRequest,
} from '@consultorio/contracts';
import { asc, desc, eq, sql } from 'drizzle-orm';

import { payerPlanPrice, price, tenantPayer } from '../../../db/schema/billing-pricing.js';
import { membership } from '../../../db/schema/identity.js';
import { payer } from '../../../db/schema/platform-catalogs.js';
import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { CURRENT_TENANT, UNIQUE_VIOLATION, sqlState, type BillingActor } from './common.js';

async function requireRow(found: PromiseLike<readonly unknown[]>): Promise<void> {
  if ((await found).length === 0) throw new AppError('not_found');
}

async function requireType(tx: Tx, id: string): Promise<void> {
  await requireRow(
    tx.select({ id: appointmentType.id }).from(appointmentType).where(eq(appointmentType.id, id)),
  );
}

/** Whichever the request names has to exist in this organization (row level security does the rest). */
async function requireScope(
  tx: Tx,
  scope: { professionalId?: string | undefined; locationId?: string | undefined },
): Promise<void> {
  if (scope.professionalId !== undefined) {
    await requireRow(
      tx
        .select({ id: professional.id })
        .from(professional)
        .where(eq(professional.id, scope.professionalId)),
    );
  }
  if (scope.locationId !== undefined) {
    await requireRow(
      tx.select({ id: location.id }).from(location).where(eq(location.id, scope.locationId)),
    );
  }
}

const priceColumns = {
  id: price.id,
  appointmentTypeId: price.appointmentTypeId,
  appointmentTypeName: appointmentType.name,
  professionalId: price.professionalId,
  professionalName: membership.displayName,
  specialty: price.specialty,
  locationId: price.locationId,
  locationName: location.name,
  amountCents: price.amountCents,
  effectiveFrom: price.effectiveFrom,
  active: price.active,
};

function priceQuery(tx: Tx) {
  return tx
    .select(priceColumns)
    .from(price)
    .innerJoin(appointmentType, eq(appointmentType.id, price.appointmentTypeId))
    .leftJoin(professional, eq(professional.id, price.professionalId))
    .leftJoin(membership, eq(membership.id, professional.membershipId))
    .leftJoin(location, eq(location.id, price.locationId));
}

type PriceView = Awaited<ReturnType<typeof priceQuery>>[number];

function toPriceDto(row: PriceView): PriceDto {
  return {
    ...row,
    // A professional without a display name still has a price; the screen shows a placeholder.
    professionalName: row.professionalId === null ? null : (row.professionalName ?? ''),
    amountCents: money(row.amountCents),
  };
}

async function loadPrice(tx: Tx, id: string): Promise<PriceDto> {
  const [row] = await priceQuery(tx).where(eq(price.id, id));
  if (!row) throw new AppError('not_found');
  return toPriceDto(row);
}

const payerPriceColumns = {
  id: payerPlanPrice.id,
  tenantPayerId: payerPlanPrice.tenantPayerId,
  catalogName: payer.name,
  customName: tenantPayer.customName,
  planName: payerPlanPrice.planName,
  appointmentTypeId: payerPlanPrice.appointmentTypeId,
  appointmentTypeName: appointmentType.name,
  payerAmountCents: payerPlanPrice.payerAmountCents,
  copagoCents: payerPlanPrice.copagoCents,
  plusCents: payerPlanPrice.plusCents,
  effectiveFrom: payerPlanPrice.effectiveFrom,
  active: payerPlanPrice.active,
};

function payerPriceQuery(tx: Tx) {
  return tx
    .select(payerPriceColumns)
    .from(payerPlanPrice)
    .innerJoin(tenantPayer, eq(tenantPayer.id, payerPlanPrice.tenantPayerId))
    .leftJoin(payer, eq(payer.id, tenantPayer.payerId))
    .innerJoin(appointmentType, eq(appointmentType.id, payerPlanPrice.appointmentTypeId));
}

type PayerPriceView = Awaited<ReturnType<typeof payerPriceQuery>>[number];

function toPayerPriceDto(row: PayerPriceView): PayerPriceDto {
  return {
    id: row.id,
    tenantPayerId: row.tenantPayerId,
    payerName: row.catalogName ?? row.customName ?? '',
    planName: row.planName,
    appointmentTypeId: row.appointmentTypeId,
    appointmentTypeName: row.appointmentTypeName,
    payerAmountCents: money(row.payerAmountCents),
    copagoCents: money(row.copagoCents),
    plusCents: money(row.plusCents),
    effectiveFrom: row.effectiveFrom,
    active: row.active,
  };
}

async function loadPayerPrice(tx: Tx, id: string): Promise<PayerPriceDto> {
  const [row] = await payerPriceQuery(tx).where(eq(payerPlanPrice.id, id));
  if (!row) throw new AppError('not_found');
  return toPayerPriceDto(row);
}

/** The whole price list: the private prices and the prices per payer plan, newest first. */
export async function listPrices(tx: Tx): Promise<PriceListResponse> {
  const prices = await priceQuery(tx).orderBy(
    asc(appointmentType.name),
    desc(price.effectiveFrom),
    asc(price.id),
  );
  const payerPrices = await payerPriceQuery(tx).orderBy(
    asc(sql`lower(coalesce(${payer.name}, ${tenantPayer.customName}))`),
    asc(appointmentType.name),
    desc(payerPlanPrice.effectiveFrom),
    asc(payerPlanPrice.id),
  );
  return { prices: prices.map(toPriceDto), payerPrices: payerPrices.map(toPayerPriceDto) };
}

export async function createPrice(
  tx: Tx,
  input: { request: CreatePriceRequest; actor: BillingActor },
): Promise<PriceDto> {
  const { request } = input;
  await requireType(tx, request.appointmentTypeId);
  await requireScope(tx, request);

  let id: string;
  try {
    const [row] = await tx
      .insert(price)
      .values({
        tenantId: CURRENT_TENANT,
        appointmentTypeId: request.appointmentTypeId,
        professionalId: request.professionalId ?? null,
        specialty: request.specialty ?? null,
        locationId: request.locationId ?? null,
        amountCents: request.amountCents,
        effectiveFrom: request.effectiveFrom,
        createdBy: input.actor.userId,
      })
      .returning({ id: price.id });
    if (!row) throw new Error('price insert returned no row');
    id = row.id;
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('billing_price_duplicate');
    throw error;
  }

  await audit(tx, {
    action: 'billing.price.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'price',
    resourceId: id,
    metadata: {
      entity: 'price',
      change: 'created',
      amountCents: request.amountCents,
      effectiveFrom: request.effectiveFrom,
    },
  });
  return loadPrice(tx, id);
}

export async function updatePrice(
  tx: Tx,
  input: { id: string; request: UpdatePriceRequest; actor: BillingActor },
): Promise<PriceDto> {
  const { request } = input;
  const [current] = await tx
    .select({ amountCents: price.amountCents, active: price.active })
    .from(price)
    .where(eq(price.id, input.id))
    .for('update');
  if (!current) throw new AppError('not_found');

  const amountChanged =
    request.amountCents !== undefined && request.amountCents !== current.amountCents;
  const activeChanged = request.active !== undefined && request.active !== current.active;
  if (amountChanged || activeChanged) {
    try {
      await tx
        .update(price)
        .set({
          ...(amountChanged ? { amountCents: request.amountCents } : {}),
          ...(activeChanged ? { active: request.active } : {}),
        })
        .where(eq(price.id, input.id));
    } catch (error) {
      // Switching a price back on can meet another active price of the same scope and day.
      if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('billing_price_duplicate');
      throw error;
    }
  }
  const audited = {
    action: 'billing.price.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'price',
    resourceId: input.id,
  } as const;
  if (amountChanged) {
    await audit(tx, {
      ...audited,
      metadata: {
        entity: 'price',
        change: 'updated',
        previousAmountCents: current.amountCents,
        amountCents: request.amountCents ?? current.amountCents,
      },
    });
  }
  if (activeChanged) {
    await audit(tx, {
      ...audited,
      metadata: { entity: 'price', change: request.active ? 'activated' : 'deactivated' },
    });
  }
  return loadPrice(tx, input.id);
}

export async function createPayerPrice(
  tx: Tx,
  input: { request: CreatePayerPriceRequest; actor: BillingActor },
): Promise<PayerPriceDto> {
  const { request } = input;
  await requireType(tx, request.appointmentTypeId);
  await requireRow(
    tx
      .select({ id: tenantPayer.id })
      .from(tenantPayer)
      .where(eq(tenantPayer.id, request.tenantPayerId)),
  );

  let id: string;
  try {
    const [row] = await tx
      .insert(payerPlanPrice)
      .values({
        tenantId: CURRENT_TENANT,
        tenantPayerId: request.tenantPayerId,
        planName: request.planName ?? null,
        appointmentTypeId: request.appointmentTypeId,
        payerAmountCents: request.payerAmountCents,
        copagoCents: request.copagoCents,
        plusCents: request.plusCents,
        effectiveFrom: request.effectiveFrom,
        createdBy: input.actor.userId,
      })
      .returning({ id: payerPlanPrice.id });
    if (!row) throw new Error('payer price insert returned no row');
    id = row.id;
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('billing_price_duplicate');
    throw error;
  }

  await audit(tx, {
    action: 'billing.price.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'payer_price',
    resourceId: id,
    metadata: {
      entity: 'payer_price',
      change: 'created',
      payerAmountCents: request.payerAmountCents,
      copagoCents: request.copagoCents,
      plusCents: request.plusCents,
      effectiveFrom: request.effectiveFrom,
    },
  });
  return loadPayerPrice(tx, id);
}

export async function updatePayerPrice(
  tx: Tx,
  input: { id: string; request: UpdatePayerPriceRequest; actor: BillingActor },
): Promise<PayerPriceDto> {
  const { request } = input;
  const [current] = await tx
    .select({
      payerAmountCents: payerPlanPrice.payerAmountCents,
      copagoCents: payerPlanPrice.copagoCents,
      plusCents: payerPlanPrice.plusCents,
      active: payerPlanPrice.active,
    })
    .from(payerPlanPrice)
    .where(eq(payerPlanPrice.id, input.id))
    .for('update');
  if (!current) throw new AppError('not_found');

  const next = {
    payerAmountCents: request.payerAmountCents ?? current.payerAmountCents,
    copagoCents: request.copagoCents ?? current.copagoCents,
    plusCents: request.plusCents ?? current.plusCents,
  };
  if (next.payerAmountCents + next.copagoCents + next.plusCents <= 0) {
    throw new AppError('validation_failed', [
      { path: 'payerAmountCents', i18nKey: 'billing.price.adds_up_to_nothing' },
    ]);
  }
  const amountsChanged =
    next.payerAmountCents !== current.payerAmountCents ||
    next.copagoCents !== current.copagoCents ||
    next.plusCents !== current.plusCents;
  const activeChanged = request.active !== undefined && request.active !== current.active;

  if (amountsChanged || activeChanged) {
    try {
      await tx
        .update(payerPlanPrice)
        .set({ ...next, ...(activeChanged ? { active: request.active } : {}) })
        .where(eq(payerPlanPrice.id, input.id));
    } catch (error) {
      if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('billing_price_duplicate');
      throw error;
    }
  }
  const audited = {
    action: 'billing.price.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'payer_price',
    resourceId: input.id,
  } as const;
  if (amountsChanged) {
    await audit(tx, {
      ...audited,
      metadata: {
        entity: 'payer_price',
        change: 'updated',
        payerAmountCents: next.payerAmountCents,
        copagoCents: next.copagoCents,
        plusCents: next.plusCents,
        previousPayerAmountCents: current.payerAmountCents,
        previousCopagoCents: current.copagoCents,
        previousPlusCents: current.plusCents,
      },
    });
  }
  if (activeChanged) {
    await audit(tx, {
      ...audited,
      metadata: { entity: 'payer_price', change: request.active ? 'activated' : 'deactivated' },
    });
  }
  return loadPayerPrice(tx, input.id);
}
