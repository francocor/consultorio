import { z } from 'zod';

import {
  ARCHIVE_PLATFORM_AUDIT_ACTIONS,
  CANCELLATION_PLATFORM_AUDIT_ACTIONS,
} from './cancellation-catalog.js';
import { SIGNUP_PLATFORM_AUDIT_ACTIONS } from './signup-catalog.js';
import { SUBSCRIPTION_PLATFORM_AUDIT_ACTIONS } from './subscriptions-catalog.js';

/**
 * Contracts of the platform operator console: who runs the platform, how organizations are created
 * and how a support grant is given. Operators are not tenant users and none of this is reachable
 * from a tenant host.
 */

/**
 * What the platform trail records. A separate catalogue from the tenant one: these entries are
 * about the platform acting, not about an organization's members.
 */
export const PLATFORM_AUDIT_ACTIONS = [
  'operator.login.success',
  'operator.login.failed',
  'operator.login.locked',
  'operator.logout',
  'tenant.created',
  'tenant.owner_invited',
  'tenant.demo_reset',
  'demo.chain_reset',
  'support.access',
  'support.denied',
  'operator.denied',
  // The country holiday catalog, which the operator maintains as data.
  'holiday.added',
  'holiday.removed',
  // The platform operator vouches for the registration of a professional, or withdraws it (Stage 5).
  'operator.matricula.verified',
  'operator.matricula.unverified',
  // Stage 6: what the platform does where there is no organization (left) to write to: the purge of
  // an unverified signup, the cancellation of an organization by the operator and the archive.
  ...SIGNUP_PLATFORM_AUDIT_ACTIONS,
  ...CANCELLATION_PLATFORM_AUDIT_ACTIONS,
  ...ARCHIVE_PLATFORM_AUDIT_ACTIONS,
  // Billing decisions of the operator: letting a parked subscription go, a refund, a reviewed surplus.
  ...SUBSCRIPTION_PLATFORM_AUDIT_ACTIONS,
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export function isPlatformAuditAction(value: string): value is PlatformAuditAction {
  return PLATFORM_AUDIT_ACTIONS.some((action) => action === value);
}

const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** One step: password and the six-digit code together, so there is no half-signed-in state. */
export const OperatorLoginRequest = z.strictObject({
  email: Email,
  password: z.string().min(1).max(256),
  code: z.string().trim().min(6).max(12),
});
export type OperatorLoginRequest = z.infer<typeof OperatorLoginRequest>;

export const OperatorDto = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
});
export type OperatorDto = z.infer<typeof OperatorDto>;

export const CreateTenantRequest = z.strictObject({
  /** The name the organization shows: its display name. The slug is generated from it. */
  name: z.string().trim().min(2).max(60),
  ownerEmail: Email,
  /** Only settable here, at creation. It can never change afterwards. */
  isDemo: z.boolean().default(false),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export const OperatorTenantDto = z.strictObject({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(['active', 'read_only', 'cancelled']),
  isDemo: z.boolean(),
  country: z.string(),
  createdAt: z.iso.datetime(),
});
export type OperatorTenantDto = z.infer<typeof OperatorTenantDto>;

export const CreateTenantResponse = z.strictObject({
  tenant: OperatorTenantDto,
  /** False when the email could not be sent: resend it from the organization's page. */
  invitationSent: z.boolean(),
  /** When the owner's invitation link stops working. The link itself only goes by email. */
  invitationExpiresAt: z.iso.datetime(),
});
export type CreateTenantResponse = z.infer<typeof CreateTenantResponse>;

export const ResendOwnerInvitationRequest = z.strictObject({ ownerEmail: Email });
export type ResendOwnerInvitationRequest = z.infer<typeof ResendOwnerInvitationRequest>;

export const ResendOwnerInvitationResponse = z.strictObject({
  invitationSent: z.boolean(),
  invitationExpiresAt: z.iso.datetime(),
});
export type ResendOwnerInvitationResponse = z.infer<typeof ResendOwnerInvitationResponse>;

export const OperatorTenantListResponse = z.strictObject({ tenants: z.array(OperatorTenantDto) });
export type OperatorTenantListResponse = z.infer<typeof OperatorTenantListResponse>;

export const DemoResetResponse = z.strictObject({ status: z.literal('done') });
export type DemoResetResponse = z.infer<typeof DemoResetResponse>;

/** The organization opens a window for the platform to help, for a stated reason. */
export const SUPPORT_GRANT_MAX_HOURS = 168;
export const CreateSupportGrantRequest = z.strictObject({
  reason: z.string().trim().min(5).max(200),
  durationHours: z.number().int().min(1).max(SUPPORT_GRANT_MAX_HOURS),
});
export type CreateSupportGrantRequest = z.infer<typeof CreateSupportGrantRequest>;

export const SupportGrantDto = z.strictObject({
  id: z.uuid(),
  reason: z.string(),
  startsAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  status: z.enum(['active', 'expired', 'revoked']),
});
export type SupportGrantDto = z.infer<typeof SupportGrantDto>;

export const SupportGrantListResponse = z.strictObject({ grants: z.array(SupportGrantDto) });
export type SupportGrantListResponse = z.infer<typeof SupportGrantListResponse>;

/** What support may see of an organization under a grant: configuration, never people or care. */
export const SupportOverviewResponse = z.strictObject({
  tenant: OperatorTenantDto,
  locations: z.array(
    z.strictObject({ name: z.string(), timeZone: z.string(), active: z.boolean() }),
  ),
  features: z.array(z.strictObject({ feature: z.string(), enabled: z.boolean() })),
  grantExpiresAt: z.iso.datetime(),
});
export type SupportOverviewResponse = z.infer<typeof SupportOverviewResponse>;

// Holiday catalog ---------------------------------------------------------------------------

/** One entry of the country catalog, as the console shows it. */
export const OperatorHolidayDto = z.strictObject({
  id: z.uuid(),
  country: z.string(),
  date: z.iso.date(),
  name: z.string(),
  kind: z.enum(['national', 'bridge']),
});
export type OperatorHolidayDto = z.infer<typeof OperatorHolidayDto>;

export const AddHolidayRequest = z.strictObject({
  country: z.string().regex(/^[A-Z]{2}$/, 'expected a two-letter country code'),
  date: z.iso.date(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['national', 'bridge']),
});
export type AddHolidayRequest = z.infer<typeof AddHolidayRequest>;

export const OperatorHolidayQuery = z.strictObject({
  country: z.string().regex(/^[A-Z]{2}$/),
  year: z.coerce.number().int().min(2000).max(2100),
});
export type OperatorHolidayQuery = z.infer<typeof OperatorHolidayQuery>;

export const OperatorHolidayListResponse = z.strictObject({
  holidays: z.array(OperatorHolidayDto),
});
export type OperatorHolidayListResponse = z.infer<typeof OperatorHolidayListResponse>;

/**
 * The provider console of development and demo deployments (`LOCAL_PROVIDERS_CONSOLE`). It lists
 * each external provider, which adapter serves customers (a local simulator, the real provider or
 * nothing) and the mode the simulator is in (such as an outage), if it has one.
 */
export const DEV_PROVIDER_ADAPTERS = ['local', 'real', 'off'] as const;

export const DevProviderDto = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1).max(60),
  adapter: z.enum(DEV_PROVIDER_ADAPTERS),
  mode: z.string().max(40).nullable(),
});
export type DevProviderDto = z.infer<typeof DevProviderDto>;

export const DevProvidersResponse = z.strictObject({ providers: z.array(DevProviderDto) });
export type DevProvidersResponse = z.infer<typeof DevProvidersResponse>;

/**
 * What a demo organization "sent" (Stage 5 integration, task 5.48): the console lists it so the
 * sign-in code of the patient portal and the other emails of the demo can be read without a
 * mailbox. Demo organizations only; fictitious addresses.
 */
export const DemoOutboxMessageDto = z.strictObject({
  id: z.uuid(),
  to: z.string().min(1).max(320),
  subject: z.string().max(998),
  text: z.string(),
  createdAt: z.iso.datetime(),
});
export type DemoOutboxMessageDto = z.infer<typeof DemoOutboxMessageDto>;

export const DemoOutboxQuery = z.strictObject({
  /** Only the messages sent to this address. */
  to: z.string().trim().min(1).max(320).optional(),
});
export type DemoOutboxQuery = z.infer<typeof DemoOutboxQuery>;

export const DemoOutboxResponse = z.strictObject({ messages: z.array(DemoOutboxMessageDto) });
export type DemoOutboxResponse = z.infer<typeof DemoOutboxResponse>;

// Matricula verification (Stage 5, S5.01) -------------------------------------------------

/** The operator's working note on a registration: plain text, never a document. */
export const MATRICULA_NOTE_MAX = 500;

export const OperatorMatriculaStatus = z.enum(['unverified', 'verified']);
export type OperatorMatriculaStatus = z.infer<typeof OperatorMatriculaStatus>;

/**
 * What the operator sees of a professional: the name, the registration and the organization, and
 * nothing of the profile or of the care (the database role cannot read more).
 */
export const OperatorMatriculaDto = z.strictObject({
  tenant: z.strictObject({ id: z.uuid(), name: z.string() }),
  professionalId: z.uuid(),
  fullName: z.string().nullable(),
  jurisdiction: z.string(),
  number: z.string(),
  status: OperatorMatriculaStatus,
  verifiedAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
});
export type OperatorMatriculaDto = z.infer<typeof OperatorMatriculaDto>;

/** The queue holds the registrations waiting for a decision; `verified` lists the decided ones. */
export const MatriculaQueueQuery = z.strictObject({
  status: OperatorMatriculaStatus.default('unverified'),
});
export type MatriculaQueueQuery = z.infer<typeof MatriculaQueueQuery>;

export const MatriculaQueueResponse = z.strictObject({ items: z.array(OperatorMatriculaDto) });
export type MatriculaQueueResponse = z.infer<typeof MatriculaQueueResponse>;

const MatriculaNote = z.string().trim().max(MATRICULA_NOTE_MAX);

/**
 * Verifying names the registration the operator checked with the issuing authority. If the
 * organization edited the number or the jurisdiction since, the server refuses (it would be
 * vouching for something nobody looked at). A note may travel with the decision.
 */
export const MatriculaVerifyRequest = z.strictObject({
  jurisdiction: z.string().trim().min(1).max(20),
  number: z.string().trim().min(1).max(40),
  note: MatriculaNote.optional(),
});
export type MatriculaVerifyRequest = z.infer<typeof MatriculaVerifyRequest>;

/** Withdrawing a verification is always safe, so it needs only an optional note. */
export const MatriculaUnverifyRequest = z.strictObject({ note: MatriculaNote.optional() });
export type MatriculaUnverifyRequest = z.infer<typeof MatriculaUnverifyRequest>;

/** Saves the note on its own, without deciding. An empty note clears it. */
export const MatriculaNoteRequest = z.strictObject({ note: MatriculaNote });
export type MatriculaNoteRequest = z.infer<typeof MatriculaNoteRequest>;
