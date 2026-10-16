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
  'support.access',
  'support.denied',
  'operator.denied',
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
