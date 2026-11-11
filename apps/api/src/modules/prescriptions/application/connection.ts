import type {
  ErxConnectionDto,
  PrescriptionCapabilityDto,
  PrescriptionProvider,
  PutErxConnectionRequest,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { erxConnection } from '../../../db/schema/prescriptions.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { readPrescriberProfile } from '../../staff/index.js';

import {
  CREDENTIALS_FIELD,
  CURRENT_TENANT,
  isSimulated,
  loadOrganization,
  providerFor,
  type Organization,
  type PrescriptionDeps,
} from './common.js';

/** The key a provider is filed under in the connection of an organization. */
export function providerKeyOf(provider: PrescriptionProvider): string {
  return isSimulated(provider) ? 'local' : 'authorized';
}

async function findConnection(tx: Tx) {
  const [row] = await tx.select().from(erxConnection);
  return row;
}

/**
 * Whether e-prescription is switched on for the organization. A demo organization is always on:
 * it only ever has the in-memory fake, so nothing real can happen, and the demo shows the product
 * working. Everybody else switches it on in the connection settings.
 */
function isEnabled(organization: Organization, row: { enabled: boolean } | undefined): boolean {
  return organization.isDemo || row?.enabled === true;
}

/** The connection of the organization to the provider. Credentials are never returned. */
export async function readConnection(tx: Tx, deps: PrescriptionDeps): Promise<ErxConnectionDto> {
  const organization = await loadOrganization(tx);
  const provider = providerFor(deps.adapters, organization);
  const row = await findConnection(tx);
  return {
    providerAvailable: provider !== undefined,
    provider: provider === undefined ? null : providerKeyOf(provider),
    enabled: isEnabled(organization, row),
    simulated: isSimulated(provider),
    credentialsSaved: row?.credentialsEnc != null,
  };
}

/**
 * Switches e-prescription on or off for the organization and, for a provider that needs them, keeps
 * its credentials (encrypted with the data key of the organization, written once and never shown
 * again). Switching it on needs a provider: a deployment that serves none cannot be connected.
 */
export async function putConnection(
  tx: Tx,
  deps: PrescriptionDeps,
  input: { actor: AuditActor; request: PutErxConnectionRequest },
): Promise<ErxConnectionDto> {
  const organization = await loadOrganization(tx);
  const provider = providerFor(deps.adapters, organization);
  const { request } = input;
  if (request.enabled && provider === undefined) {
    throw new AppError('prescription_provider_not_connected');
  }
  const existing = await findConnection(tx);
  const providerKey =
    provider === undefined ? (existing?.providerKey ?? 'local') : providerKeyOf(provider);
  const now = deps.clock();

  let id = existing?.id;
  if (existing) {
    await tx
      .update(erxConnection)
      .set({
        providerKey,
        enabled: request.enabled,
        status: request.enabled ? 'active' : 'inactive',
        ...(request.enabled && !existing.enabled ? { connectedAt: now } : {}),
      })
      .where(eq(erxConnection.id, existing.id));
  } else {
    const [created] = await tx
      .insert(erxConnection)
      .values({
        tenantId: CURRENT_TENANT,
        providerKey,
        enabled: request.enabled,
        status: request.enabled ? 'active' : 'inactive',
        connectedAt: request.enabled ? now : null,
      })
      .returning({ id: erxConnection.id });
    id = created?.id;
  }
  if (!id) throw new Error('the connection could not be saved');

  if (request.credentials !== undefined) {
    const blob = await deps.keys.encryptField(
      tx,
      { ...CREDENTIALS_FIELD, rowId: id },
      request.credentials,
    );
    await tx.update(erxConnection).set({ credentialsEnc: blob }).where(eq(erxConnection.id, id));
  }

  await audit(tx, {
    action: 'setting.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'erx_connection',
    resourceId: id,
    metadata: {
      setting: 'erx_connection',
      enabled: request.enabled,
      credentialsChanged: request.credentials !== undefined,
    },
  });
  return readConnection(tx, deps);
}

/**
 * The provider that serves the organization when it can issue at all: it has one, and the switch is
 * on. Without it, the provider is undefined.
 */
export async function connectedProvider(
  tx: Tx,
  deps: PrescriptionDeps,
): Promise<{ provider: PrescriptionProvider | undefined; organization: Organization }> {
  const organization = await loadOrganization(tx);
  const provider = providerFor(deps.adapters, organization);
  const row = await findConnection(tx);
  return {
    provider: provider !== undefined && isEnabled(organization, row) ? provider : undefined,
    organization,
  };
}

/**
 * The provider that will issue, or "provider not connected" (the screen sends the owner to the
 * settings).
 */
export async function requireProvider(
  tx: Tx,
  deps: PrescriptionDeps,
): Promise<{ provider: PrescriptionProvider; organization: Organization }> {
  const { provider, organization } = await connectedProvider(tx, deps);
  if (!provider) throw new AppError('prescription_provider_not_connected');
  return { provider, organization };
}

/** What the screen of one professional needs to know before it shows the form. */
export async function capabilityOf(
  tx: Tx,
  deps: PrescriptionDeps,
  professionalId: string,
): Promise<PrescriptionCapabilityDto> {
  const organization = await loadOrganization(tx);
  const provider = providerFor(deps.adapters, organization);
  const row = await findConnection(tx);
  const profile = await readPrescriberProfile(tx, professionalId);
  const matriculaStatus =
    profile?.matricula == null || profile.jurisdiction == null
      ? ('missing' as const)
      : profile.matriculaStatus;
  const enabled = isEnabled(organization, row);
  return {
    professionalId,
    providerAvailable: provider !== undefined,
    enabled,
    simulated: isSimulated(provider),
    matriculaStatus,
    canIssue:
      provider !== undefined &&
      enabled &&
      matriculaStatus === 'verified' &&
      profile?.status === 'active',
  };
}
