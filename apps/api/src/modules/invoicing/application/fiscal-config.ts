import type {
  CreatePointOfSaleRequest,
  CredentialSummaryDto,
  FieldError,
  FiscalConfigResponse,
  FiscalProfileDto,
  PointOfSaleDto,
  UpdatePointOfSaleRequest,
  UpsertFiscalProfileRequest,
} from '@consultorio/contracts';
import { asc, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';

import {
  fiscalCredential,
  fiscalProfile,
  invoice,
  pointOfSale,
  type FiscalCredentialRow,
  type FiscalProfileRow,
  type PointOfSaleRow,
} from '../../../db/schema/index.js';
import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { credentialState } from '../domain/credential.js';

import { CHECK_VIOLATION, sqlState } from './common.js';
import { packFor } from './country-rules.js';
import { isSimulatedIssuer, issuerFor } from './issuer.js';
import { invoicingReadiness } from './readiness.js';
import { loadOrganization } from './settings.js';

export interface FiscalDeps {
  adapters?: AdapterResolver | undefined;
  clock: () => Date;
}

/** Who acts, for the audit trail: the signed-in member. */
export type FiscalActor = AuditActor & { userId: string };

const PROFILE_FIELDS = [
  'cuit',
  'taxCondition',
  'businessName',
  'address',
  'activityStartedOn',
] as const;

export function profileDto(row: FiscalProfileRow): FiscalProfileDto {
  return {
    cuit: row.cuit,
    taxCondition: row.taxCondition as FiscalProfileDto['taxCondition'],
    businessName: row.businessName,
    address: row.address,
    activityStartedOn: row.activityStartedOn,
  };
}

/** The environment that is really used: a simulator has only the test one. */
export function effectiveEnvironment(
  chosen: string,
  simulated: boolean,
): PointOfSaleDto['environment'] {
  return simulated || chosen !== 'production' ? 'homologation' : 'production';
}

export function pointOfSaleDto(row: PointOfSaleRow, simulated: boolean): PointOfSaleDto {
  const environment = row.environment === 'production' ? 'production' : 'homologation';
  return {
    id: row.id,
    number: row.number,
    environment,
    effectiveEnvironment: effectiveEnvironment(environment, simulated),
    active: row.active,
  };
}

/** What may be said about the certificate: its state and dates, never the certificate. */
export function credentialSummary(
  row: FiscalCredentialRow,
  profileCuit: string,
  now: Date,
): CredentialSummaryDto {
  return {
    state: credentialState({
      notBefore: row.notBefore,
      notAfter: row.notAfter,
      subjectCuit: row.subjectCuit,
      profileCuit,
      now,
    }),
    notBefore: row.notBefore.toISOString(),
    notAfter: row.notAfter.toISOString(),
    subjectCuit: row.subjectCuit,
    fingerprint: row.fingerprint,
    uploadedAt: row.createdAt.toISOString(),
  };
}

/** The whole fiscal configuration of the organization, with whether invoicing can run. */
export async function getFiscalConfig(tx: Tx, deps: FiscalDeps): Promise<FiscalConfigResponse> {
  const organization = await loadOrganization(tx);
  const issuer = issuerFor(deps.adapters, { id: organization.id, isDemo: organization.isDemo });
  const simulated = isSimulatedIssuer(issuer);

  const [profile] = await tx.select().from(fiscalProfile);
  const points = await tx.select().from(pointOfSale).orderBy(asc(pointOfSale.number));
  const [credential] = await tx
    .select()
    .from(fiscalCredential)
    .where(eq(fiscalCredential.active, true));

  return {
    enabled: organization.enabled,
    profile: profile ? profileDto(profile) : null,
    pointsOfSale: points.map((point) => pointOfSaleDto(point, simulated)),
    credential:
      credential && profile ? credentialSummary(credential, profile.cuit, deps.clock()) : null,
    readiness: await invoicingReadiness(tx, deps, organization),
  };
}

/** Today in the organization's time zone, as `YYYY-MM-DD`. */
function today(now: Date, timeZone: string): string {
  return DateTime.fromJSDate(now, { zone: timeZone }).toISODate() ?? now.toISOString().slice(0, 10);
}

/**
 * Saves the fiscal identity (one per organization). The CUIT goes through the check digit of the
 * country pack and is stored as digits. Nothing is written, and nothing audited, when the request
 * changes nothing.
 */
export async function upsertFiscalProfile(
  tx: Tx,
  deps: FiscalDeps,
  input: { actor: FiscalActor; tenantId: string; request: UpsertFiscalProfileRequest },
): Promise<FiscalProfileDto> {
  const organization = await loadOrganization(tx);
  const pack = packFor(organization.country);
  const errors: FieldError[] = [];

  const cuit = pack.validateTaxId(input.request.cuit);
  if (!cuit.ok) errors.push({ path: 'cuit', i18nKey: cuit.error.i18nKey });
  if (input.request.activityStartedOn > today(deps.clock(), pack.defaults.timeZone)) {
    errors.push({ path: 'activityStartedOn', i18nKey: 'invoicing.profile.activity_in_future' });
  }
  if (!cuit.ok || errors.length > 0) throw new AppError('validation_failed', errors);

  const next = {
    cuit: cuit.value,
    taxCondition: input.request.taxCondition,
    businessName: input.request.businessName,
    address: input.request.address,
    activityStartedOn: input.request.activityStartedOn,
  };
  const [current] = await tx.select().from(fiscalProfile);
  const changedFields = current
    ? PROFILE_FIELDS.filter((field) => current[field] !== next[field])
    : [...PROFILE_FIELDS];
  if (current && changedFields.length === 0) return profileDto(current);

  const [saved] = current
    ? await tx
        .update(fiscalProfile)
        .set({ ...next, updatedBy: input.actor.userId })
        .where(eq(fiscalProfile.id, current.id))
        .returning()
    : await tx
        .insert(fiscalProfile)
        .values({ tenantId: input.tenantId, ...next, updatedBy: input.actor.userId })
        .returning();
  if (!saved) throw new AppError('internal_error');

  await audit(tx, {
    action: 'invoicing.config.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'fiscal_profile',
    resourceId: saved.id,
    metadata: { section: 'profile', created: current === undefined, changedFields },
  });
  return profileDto(saved);
}

/** A unique violation of the database (a number that is already taken). */
function isUniqueViolation(error: unknown): boolean {
  return (error as { cause?: { code?: string } } | null)?.cause?.code === '23505';
}

export async function createPointOfSale(
  tx: Tx,
  deps: FiscalDeps,
  input: { actor: FiscalActor; tenantId: string; request: CreatePointOfSaleRequest },
): Promise<PointOfSaleDto> {
  const organization = await loadOrganization(tx);
  const simulated = isSimulatedIssuer(
    issuerFor(deps.adapters, { id: organization.id, isDemo: organization.isDemo }),
  );
  const [existing] = await tx
    .select({ id: pointOfSale.id })
    .from(pointOfSale)
    .where(eq(pointOfSale.number, input.request.number));
  if (existing) throw new AppError('conflict');

  let created: PointOfSaleRow | undefined;
  try {
    [created] = await tx
      .insert(pointOfSale)
      .values({
        tenantId: input.tenantId,
        number: input.request.number,
        environment: input.request.environment ?? 'homologation',
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('conflict');
    throw error;
  }
  if (!created) throw new AppError('internal_error');

  await audit(tx, {
    action: 'invoicing.config.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'point_of_sale',
    resourceId: created.id,
    metadata: {
      section: 'point_of_sale',
      created: true,
      pointOfSale: created.number,
      changedFields: ['number', 'environment'],
    },
  });
  return pointOfSaleDto(created, simulated);
}

export async function updatePointOfSale(
  tx: Tx,
  deps: FiscalDeps,
  input: { actor: FiscalActor; id: string; request: UpdatePointOfSaleRequest },
): Promise<PointOfSaleDto> {
  const organization = await loadOrganization(tx);
  const simulated = isSimulatedIssuer(
    issuerFor(deps.adapters, { id: organization.id, isDemo: organization.isDemo }),
  );
  const [current] = await tx.select().from(pointOfSale).where(eq(pointOfSale.id, input.id));
  if (!current) throw new AppError('not_found');

  const changedFields: string[] = [];
  const patch: Partial<Pick<PointOfSaleRow, 'environment' | 'active'>> = {};
  if (
    input.request.environment !== undefined &&
    input.request.environment !== current.environment
  ) {
    patch.environment = input.request.environment;
    changedFields.push('environment');
  }
  if (input.request.active !== undefined && input.request.active !== current.active) {
    patch.active = input.request.active;
    changedFields.push('active');
  }
  if (changedFields.length === 0) return pointOfSaleDto(current, simulated);

  // The numbers of the other environment start again at 1: once invoices went through this point of
  // sale they would collide with the vouchers that exist (JD-S4 R1-C8). A new point of sale has the
  // other environment.
  if (patch.environment !== undefined) {
    const [used] = await tx
      .select({ id: invoice.id })
      .from(invoice)
      .where(eq(invoice.pointOfSale, current.number))
      .limit(1);
    if (used) throw new AppError('point_of_sale_has_invoices');
  }

  // The check above reads without a lock: an invoice being created at this moment is invisible to it.
  // The database settles it (a trigger waits for that invoice and refuses), JD-S4 R2-4.
  const [updated] = await tx
    .update(pointOfSale)
    .set(patch)
    .where(eq(pointOfSale.id, current.id))
    .returning()
    .catch((error: unknown) => {
      if (patch.environment !== undefined && sqlState(error) === CHECK_VIOLATION) {
        throw new AppError('point_of_sale_has_invoices');
      }
      throw error;
    });
  if (!updated) throw new AppError('internal_error');

  await audit(tx, {
    action: 'invoicing.config.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'point_of_sale',
    resourceId: updated.id,
    metadata: { section: 'point_of_sale', pointOfSale: updated.number, changedFields },
  });
  return pointOfSaleDto(updated, simulated);
}
