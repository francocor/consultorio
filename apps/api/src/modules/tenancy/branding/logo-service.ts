import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import type { BrandingResponse } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';

import { tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import {
  tenantKey,
  type ObjectStorage,
  type StoredObject,
} from '../../../platform/storage/object-storage.js';

import { readBranding } from './branding.js';
import { ensureAccessiblePrimary } from './contrast.js';
import { LogoRejected, normalizeLogo } from './logo.js';

interface StoredLogo {
  key: string;
  version: number;
  width: number;
  height: number;
}

export interface LogoChange {
  response: BrandingResponse;
  /** The object that is no longer referenced: remove it after the transaction commits. */
  staleKey: string | null;
}

export interface LogoService {
  upload(
    tx: Tx,
    input: { actor: AuditActor; tenantId: string; bytes: Buffer; contentType: string },
  ): Promise<LogoChange>;
  remove(tx: Tx, input: { actor: AuditActor; tenantId: string }): Promise<LogoChange>;
  /** The logo of the tenant, optionally scaled to a square icon size. Null when there is none. */
  read(tx: Tx, input: { tenantId: string; iconSize?: 192 | 512 }): Promise<StoredObject | null>;
  /** Removes an object that nothing refers to any more. Failure is not an error: it is only waste. */
  discard(tenantId: string, key: string): Promise<void>;
  /** Whether logos can be stored at all in this deployment. */
  readonly available: boolean;
}

function storedLogo(theme: Record<string, unknown>): StoredLogo | null {
  const logo = theme['logo'];
  if (typeof logo !== 'object' || logo === null) return null;
  const { key, version, width, height } = logo as Record<string, unknown>;
  return typeof key === 'string' &&
    typeof version === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number'
    ? { key, version, width, height }
    : null;
}

async function currentTheme(tx: Tx): Promise<{ id: string; theme: Record<string, unknown> }> {
  const [row] = await tx.select({ id: tenant.id, theme: tenant.theme }).from(tenant);
  if (!row) throw new AppError('not_found');
  return row;
}

function responseOf(theme: Record<string, unknown>): BrandingResponse {
  const branding = readBranding(theme);
  const contrast = ensureAccessiblePrimary(branding.primaryRequested);
  return {
    branding,
    contrast: {
      requested: contrast.requested,
      effective: contrast.effective,
      foreground: contrast.foreground,
      adjusted: contrast.adjusted,
      ratio: Math.round(contrast.ratio * 100) / 100,
      warning: contrast.warning,
    },
  };
}

export function createLogoService(deps: { storage?: ObjectStorage | undefined }): LogoService {
  const storage = deps.storage;

  return {
    available: storage !== undefined,

    async upload(tx, input) {
      if (!storage) throw new AppError('service_unavailable');
      let logo;
      try {
        logo = await normalizeLogo(input.bytes, input.contentType);
      } catch (error) {
        if (error instanceof LogoRejected) {
          throw new AppError('validation_failed', [{ path: 'logo', i18nKey: error.reason }]);
        }
        throw error;
      }

      const row = await currentTheme(tx);
      const previous = storedLogo(row.theme);
      const version = (previous?.version ?? 0) + 1;
      const key = tenantKey(input.tenantId, 'branding', `logo-${String(version)}.png`);
      await storage.put(input.tenantId, key, { body: logo.bytes, contentType: logo.contentType });
      try {
        const theme = {
          ...row.theme,
          logo: { key, version, width: logo.width, height: logo.height },
        };
        await tx
          .update(tenant)
          .set({ theme: sql`${tenant.theme} || ${JSON.stringify({ logo: theme.logo })}::jsonb` })
          .where(eq(tenant.id, row.id));
        await audit(tx, {
          action: 'branding.logo_updated',
          outcome: 'allow',
          actor: input.actor,
          resourceType: 'tenant',
          resourceId: row.id,
          metadata: { version, width: logo.width, height: logo.height, bytes: logo.bytes.length },
        });
        return { response: responseOf(theme), staleKey: previous?.key ?? null };
      } catch (error) {
        // The database refused: do not leave the new object behind.
        await storage.remove(input.tenantId, key).catch(() => undefined);
        throw error;
      }
    },

    async remove(tx, input) {
      const row = await currentTheme(tx);
      const previous = storedLogo(row.theme);
      if (!previous) return { response: responseOf(row.theme), staleKey: null };
      await tx
        .update(tenant)
        .set({ theme: sql`${tenant.theme} - 'logo'` })
        .where(eq(tenant.id, row.id));
      await audit(tx, {
        action: 'branding.logo_updated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'tenant',
        resourceId: row.id,
        metadata: { removed: true, version: previous.version },
      });
      const rest = Object.fromEntries(
        Object.entries(row.theme).filter(([name]) => name !== 'logo'),
      );
      return { response: responseOf(rest), staleKey: previous.key };
    },

    async read(tx, input) {
      if (!storage) return null;
      const logo = storedLogo((await currentTheme(tx)).theme);
      if (!logo) return null;
      const object = await storage.get(input.tenantId, logo.key);
      if (!object || input.iconSize === undefined) return object;
      // A square icon for the installable app: the logo, centered on a transparent square.
      const bytes = await sharp(await buffer(object.stream))
        .resize({
          width: input.iconSize,
          height: input.iconSize,
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      return { size: bytes.length, contentType: 'image/png', stream: Readable.from([bytes]) };
    },

    async discard(tenantId, key) {
      if (!storage) return;
      await storage.remove(tenantId, key).catch(() => undefined);
    },
  };
}
