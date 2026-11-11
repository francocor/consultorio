import { PAYER_KINDS, type PayerSeed } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../platform/db/pool.js';
import { payer } from '../schema/platform-catalogs.js';

import raw from './ar-payers.json' with { type: 'json' };

const payerSeedSchema = z.array(
  z.strictObject({
    country: z.literal('AR'),
    code: z.string().regex(/^[a-z0-9_]+$/),
    name: z.string().min(1),
    kind: z.enum(PAYER_KINDS),
  }),
);

/**
 * Starting payer catalog (obras sociales, prepagas and the self-pay option). It is a seed, not an
 * exhaustive registry: the platform operator completes it as data. Validated when the module loads,
 * so a malformed edit of the JSON fails every test that imports it.
 */
export const arPayers: PayerSeed[] = payerSeedSchema.parse(raw);

/** Loads the Argentine payers. Idempotent on (country, code); an existing row is refreshed. */
export async function seedArPayers(db: Db): Promise<void> {
  await db
    .insert(payer)
    .values(arPayers)
    .onConflictDoUpdate({
      target: [payer.country, payer.code],
      set: { name: sql`excluded.name`, kind: sql`excluded.kind` },
    });
}
