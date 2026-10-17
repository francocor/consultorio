import {
  effectivePermissions,
  type BootPayload,
  type MeResponse,
  type Role,
} from '@consultorio/contracts';

export const USER_ID = '0190a000-0000-7000-8000-000000000001';

/** The profile `/auth/me` would return for a user with these roles (and optional grants). */
export function meFor(
  roles: readonly Role[],
  overrides: Partial<MeResponse> & { grants?: string[] } = {},
): MeResponse {
  const { grants = [], ...rest } = overrides;
  return {
    user: { id: USER_ID, email: 'ana.perez@example.test' },
    roles: [...roles],
    permissions: effectivePermissions(roles, grants),
    scope: 'full',
    twoFactor: { enrolled: true, required: true, graceEndsAt: null },
    tenantStatus: 'active',
    needsWizard: false,
    ...rest,
  };
}

export function bootFor(name = 'Clínica Norte', overrides: Partial<BootPayload> = {}): BootPayload {
  return {
    name,
    shortName: name.slice(0, 12),
    theme: { primary: '#0f766e', primaryForeground: '#ffffff', radius: 'md', headingFont: 'inter' },
    logoUrl: null,
    locale: 'es-AR',
    features: [],
    deploymentMode: 'multi',
    isDemo: false,
    ...overrides,
  };
}
