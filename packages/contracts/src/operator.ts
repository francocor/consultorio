import { z } from 'zod';

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
