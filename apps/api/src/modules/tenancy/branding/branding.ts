import {
  BRANDING_FONTS,
  BRANDING_RADII,
  DEFAULT_BRANDING,
  type BrandingDto,
  type BrandingFont,
  type BrandingRadius,
  type BrandingResponse,
  type ContrastResultDto,
  type UpdateBrandingRequest,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { ensureAccessiblePrimary, normalizeHex } from './contrast.js';

type Theme = Record<string, unknown>;

/** Where the logo of an organization is served from; `v` changes whenever the logo does. */
export function logoUrlFor(version: number): string {
  return `/public/branding/logo?v=${String(version)}`;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback;
}

/** What `tenant.theme` says, with the neutral product defaults for anything that was never set. */
export function readBranding(theme: Theme): BrandingDto {
  const requested =
    normalizeHex(typeof theme['primaryRequested'] === 'string' ? theme['primaryRequested'] : '') ??
    DEFAULT_BRANDING.primaryColor;
  // The effective color is a function of the requested one; recomputing it means a change to the
  // rule reaches every organization without a data migration.
  const contrast = ensureAccessiblePrimary(requested);
  const logo = theme['logo'];
  const version =
    typeof logo === 'object' &&
    logo !== null &&
    typeof (logo as { version?: unknown }).version === 'number'
      ? (logo as { version: number }).version
      : null;
  return {
    displayName: text(theme['displayName']),
    shortName: text(theme['shortName']),
    primaryRequested: requested,
    primaryEffective: contrast.effective,
    primaryForeground: contrast.foreground,
    radius: oneOf<BrandingRadius>(BRANDING_RADII, theme['radius'], DEFAULT_BRANDING.radius),
    headingFont: oneOf<BrandingFont>(
      BRANDING_FONTS,
      theme['headingFont'],
      DEFAULT_BRANDING.headingFont,
    ),
    logoUrl: version === null ? null : logoUrlFor(version),
  };
}

function contrastDto(color: string): ContrastResultDto {
  const result = ensureAccessiblePrimary(color);
  return {
    requested: result.requested,
    effective: result.effective,
    foreground: result.foreground,
    adjusted: result.adjusted,
    ratio: Math.round(result.ratio * 100) / 100,
    warning: result.warning,
  };
}

export interface BrandingService {
  get(tx: Tx): Promise<BrandingResponse>;
  preview(color: string): ContrastResultDto;
  update(
    tx: Tx,
    input: { actor: AuditActor; request: UpdateBrandingRequest },
  ): Promise<BrandingResponse>;
}

async function currentTenant(tx: Tx): Promise<{ id: string; theme: Theme }> {
  const [row] = await tx.select({ id: tenant.id, theme: tenant.theme }).from(tenant);
  if (!row) throw new AppError('not_found');
  return row;
}

export function createBrandingService(): BrandingService {
  return {
    async get(tx) {
      const branding = readBranding((await currentTenant(tx)).theme);
      return { branding, contrast: contrastDto(branding.primaryRequested) };
    },

    preview(color) {
      return contrastDto(color);
    },

    async update(tx, input) {
      const row = await currentTenant(tx);
      const before = readBranding(row.theme);
      const requested = normalizeHex(input.request.primaryColor);
      if (requested === null) {
        throw new AppError('validation_failed', [
          { path: 'primaryColor', i18nKey: 'errors.field_invalid' },
        ]);
      }
      const contrast = ensureAccessiblePrimary(requested);

      const next = {
        displayName: input.request.displayName,
        shortName: input.request.shortName,
        primaryRequested: contrast.requested,
        primaryEffective: contrast.effective,
        primaryForeground: contrast.foreground,
        radius: input.request.radius,
        headingFont: input.request.headingFont,
      };
      const changes: [string, string | null, string][] = [];
      if (before.displayName !== next.displayName)
        changes.push(['displayName', before.displayName, next.displayName]);
      if (before.shortName !== next.shortName)
        changes.push(['shortName', before.shortName, next.shortName]);
      if (before.primaryRequested !== next.primaryRequested) {
        changes.push(['primaryColor', before.primaryRequested, next.primaryRequested]);
      }
      if (before.radius !== next.radius) changes.push(['radius', before.radius, next.radius]);
      if (before.headingFont !== next.headingFont)
        changes.push(['headingFont', before.headingFont, next.headingFont]);

      if (changes.length > 0) {
        // A merge: the logo and any other key of the theme survive.
        await tx
          .update(tenant)
          .set({ theme: sql`${tenant.theme} || ${JSON.stringify(next)}::jsonb` })
          .where(eq(tenant.id, row.id));
        await audit(tx, {
          action: 'branding.updated',
          outcome: 'allow',
          actor: input.actor,
          resourceType: 'tenant',
          resourceId: row.id,
          // The diff: what each changed field was and became. Branding is not personal data.
          metadata: {
            fields: changes.map(([field]) => field),
            ...Object.fromEntries(
              changes.flatMap(([field, was, now]) => [
                [`${field}_before`, was],
                [`${field}_after`, now],
              ]),
            ),
          },
        });
      }
      const after = readBranding((await currentTenant(tx)).theme);
      return { branding: after, contrast: contrastDto(after.primaryRequested) };
    },
  };
}
