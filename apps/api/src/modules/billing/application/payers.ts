import type {
  BillingPayerKind,
  CreateTenantPayerRequest,
  PayerListResponse,
  TenantPayerDto,
  UpdateTenantPayerRequest,
} from '@consultorio/contracts';
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';

import { tenantPayer } from '../../../db/schema/billing-pricing.js';
import { payer } from '../../../db/schema/platform-catalogs.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { CURRENT_TENANT, UNIQUE_VIOLATION, sqlState, type BillingActor } from './common.js';
import { validTaxId } from './tax-id.js';

interface PayerRow {
  id: string;
  payerId: string | null;
  customName: string | null;
  cuit: string | null;
  active: boolean;
  deactivatedAt: Date | null;
  catalogName: string | null;
  catalogKind: string | null;
}

const columns = {
  id: tenantPayer.id,
  payerId: tenantPayer.payerId,
  customName: tenantPayer.customName,
  cuit: tenantPayer.cuit,
  active: tenantPayer.active,
  deactivatedAt: tenantPayer.deactivatedAt,
  catalogName: payer.name,
  catalogKind: payer.kind,
};

function kindOf(row: PayerRow): BillingPayerKind {
  switch (row.catalogKind) {
    case 'obra_social':
    case 'prepaga':
    case 'private':
      return row.catalogKind;
    default:
      return 'custom';
  }
}

export function toPayerDto(row: PayerRow): TenantPayerDto {
  return {
    id: row.id,
    payerId: row.payerId,
    name: row.catalogName ?? row.customName ?? '',
    kind: kindOf(row),
    cuit: row.cuit,
    active: row.active,
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
  };
}

async function loadPayer(tx: Tx, id: string): Promise<TenantPayerDto> {
  const [row] = await tx
    .select(columns)
    .from(tenantPayer)
    .leftJoin(payer, eq(payer.id, tenantPayer.payerId))
    .where(eq(tenantPayer.id, id));
  if (!row) throw new AppError('not_found');
  return toPayerDto(row);
}

/** The payers of the organization (active or not) and what is left to copy from the catalog. */
export async function listPayers(tx: Tx, country: string): Promise<PayerListResponse> {
  const rows = await tx
    .select(columns)
    .from(tenantPayer)
    .leftJoin(payer, eq(payer.id, tenantPayer.payerId))
    .orderBy(
      asc(sql`lower(coalesce(${payer.name}, ${tenantPayer.customName}))`),
      asc(tenantPayer.id),
    );
  const copied = rows.flatMap((row) => (row.payerId === null ? [] : [row.payerId]));

  const available = await tx
    .select({ payerId: payer.id, name: payer.name, kind: payer.kind })
    .from(payer)
    .where(
      and(
        eq(payer.country, country),
        eq(payer.active, true),
        ...(copied.length > 0 ? [notInArray(payer.id, copied)] : []),
      ),
    )
    .orderBy(asc(payer.name));

  return {
    payers: rows.map(toPayerDto),
    available: available.flatMap((row) =>
      row.kind === 'obra_social' || row.kind === 'prepaga' || row.kind === 'private'
        ? [{ payerId: row.payerId, name: row.name, kind: row.kind }]
        : [],
    ),
  };
}

/** Copies a payer of the catalog into the organization's list, or adds one of its own. */
export async function addPayer(
  tx: Tx,
  input: { request: CreateTenantPayerRequest; country: string; actor: BillingActor },
): Promise<TenantPayerDto> {
  const { request } = input;
  if ('payerId' in request) {
    const [found] = await tx
      .select({ id: payer.id })
      .from(payer)
      .where(
        and(
          eq(payer.id, request.payerId),
          eq(payer.country, input.country),
          eq(payer.active, true),
        ),
      );
    if (!found) throw new AppError('not_found');
  }
  const cuit = request.cuit === undefined ? null : validTaxId(input.country, request.cuit);

  let id: string;
  try {
    const [row] = await tx
      .insert(tenantPayer)
      .values({
        tenantId: CURRENT_TENANT,
        payerId: 'payerId' in request ? request.payerId : null,
        customName: 'customName' in request ? request.customName : null,
        cuit,
      })
      .returning({ id: tenantPayer.id });
    if (!row) throw new Error('payer insert returned no row');
    id = row.id;
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('billing_payer_exists');
    throw error;
  }

  const created = await loadPayer(tx, id);
  await audit(tx, {
    action: 'billing.price.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'payer',
    resourceId: id,
    metadata: {
      entity: 'payer',
      change: 'created',
      source: created.payerId ? 'catalog' : 'custom',
      cuit: cuit !== null,
    },
  });
  return created;
}

/**
 * Deactivates or reactivates a payer, and sets or removes its CUIT. The row stays: charges made for
 * it keep showing it. The CUIT goes through the country pack (digits and check digit).
 */
export async function updatePayer(
  tx: Tx,
  input: {
    id: string;
    request: UpdateTenantPayerRequest;
    country: string;
    actor: BillingActor;
    now: Date;
  },
): Promise<TenantPayerDto> {
  const { request } = input;
  const [current] = await tx
    .select({ active: tenantPayer.active, cuit: tenantPayer.cuit })
    .from(tenantPayer)
    .where(eq(tenantPayer.id, input.id))
    .for('update');
  if (!current) throw new AppError('not_found');

  const cuit =
    request.cuit === undefined
      ? current.cuit
      : request.cuit === null
        ? null
        : validTaxId(input.country, request.cuit);
  const activeChanged = request.active !== undefined && request.active !== current.active;
  const cuitChanged = cuit !== current.cuit;

  if (activeChanged || cuitChanged) {
    await tx
      .update(tenantPayer)
      .set({
        cuit,
        ...(activeChanged
          ? {
              active: request.active ?? current.active,
              deactivatedAt: request.active ? null : input.now,
            }
          : {}),
      })
      .where(eq(tenantPayer.id, input.id));
  }
  if (activeChanged) {
    await audit(tx, {
      action: 'billing.price.changed',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'payer',
      resourceId: input.id,
      metadata: { entity: 'payer', change: request.active ? 'activated' : 'deactivated' },
    });
  }
  if (cuitChanged) {
    await audit(tx, {
      action: 'billing.price.changed',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'payer',
      resourceId: input.id,
      metadata: { entity: 'payer', change: 'cuit_changed', cuit: cuit !== null },
    });
  }
  return loadPayer(tx, input.id);
}
