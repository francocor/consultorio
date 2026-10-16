import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * The name of the organization as people see it: the display name from its branding, or the slug
 * until it sets one. Used in the emails the organization sends.
 */
export async function readOrganizationName(tx: Tx): Promise<string> {
  const [row] = await tx.select({ slug: tenant.slug, theme: tenant.theme }).from(tenant);
  if (!row) return '';
  const name = row.theme['displayName'];
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : row.slug;
}
