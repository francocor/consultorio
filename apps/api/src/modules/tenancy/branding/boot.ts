import { type BootPayload, type WebManifest } from '@consultorio/contracts';
import { asc, eq } from 'drizzle-orm';

import { tenant, tenantFeature } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ResolvedTenant } from '../../../platform/http/tenant-host.js';

import { logoIconUrlFor, logoVersionOf, readBranding } from './branding.js';

/** Characters of the short name taken from the full name when the organization sets none. */
const SHORT_NAME_LENGTH = 12;

const PRODUCT_ICONS = [
  { src: '/icons/icon-192.png', size: 192 },
  { src: '/icons/icon-512.png', size: 512 },
] as const;

export interface BootService {
  boot(tx: Tx, resolved: ResolvedTenant): Promise<BootPayload>;
  manifest(tx: Tx, resolved: ResolvedTenant): Promise<WebManifest>;
}

export interface BootDeps {
  deploymentMode: 'multi' | 'single';
  /** The interface language of an organization, from its country. */
  locale: (country: string) => string;
}

/**
 * What a browser needs before anyone signs in: the look of the organization, the language and the
 * features that are on. Every value is whitelisted here, so nothing about people or the
 * organization's internals can leak through a public endpoint.
 */
export function createBootService(deps: BootDeps): BootService {
  async function identity(tx: Tx, resolved: ResolvedTenant) {
    const [row] = await tx
      .select({ slug: tenant.slug, theme: tenant.theme })
      .from(tenant)
      .where(eq(tenant.id, resolved.id));
    if (!row) throw new AppError('not_found');
    const branding = readBranding(row.theme);
    const name = branding.displayName ?? row.slug;
    const shortName = branding.shortName ?? name.slice(0, SHORT_NAME_LENGTH).trim();
    return { branding, name, shortName, logoVersion: logoVersionOf(row.theme) };
  }

  return {
    async boot(tx, resolved) {
      const { branding, name, shortName } = await identity(tx, resolved);
      const features = await tx
        .select({ feature: tenantFeature.feature })
        .from(tenantFeature)
        .where(eq(tenantFeature.enabled, true))
        .orderBy(asc(tenantFeature.feature));
      return {
        name,
        shortName,
        theme: {
          primary: branding.primaryEffective,
          primaryForeground: branding.primaryForeground,
          radius: branding.radius,
          headingFont: branding.headingFont,
        },
        logoUrl: branding.logoUrl,
        locale: deps.locale(resolved.country),
        features: features.map((row) => row.feature),
        deploymentMode: deps.deploymentMode,
        isDemo: resolved.isDemo,
      };
    },

    async manifest(tx, resolved) {
      const { branding, name, shortName, logoVersion } = await identity(tx, resolved);
      // With a logo the icons are the logo centered on a square; without one, the product's own.
      const icons = PRODUCT_ICONS.map((icon) => ({
        src: logoVersion === null ? icon.src : logoIconUrlFor(logoVersion, icon.size),
        sizes: `${String(icon.size)}x${String(icon.size)}`,
        type: 'image/png',
        purpose: 'any',
      }));
      return {
        name,
        short_name: shortName,
        start_url: '/',
        scope: '/',
        display: 'standalone',
        lang: deps.locale(resolved.country),
        theme_color: branding.primaryEffective,
        background_color: '#ffffff',
        icons,
      };
    },
  };
}
