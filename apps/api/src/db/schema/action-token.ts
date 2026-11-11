import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { tenant } from './tenant.js';

/**
 * A single-purpose link sent to someone (design 4.5): password reset, staff invitation, and the
 * other kinds of the canonical list. Only the SHA-256 of the 256-bit random token is stored, so a
 * database dump cannot be used to open a link. Redeeming is one atomic UPDATE that checks the
 * kind, the expiry, the number of uses and the optional session binding together.
 *
 * `subject_id` is the thing the link is about (a user, an appointment, a document); it is not a
 * foreign key because it points to different tables depending on the kind. `payload` carries the
 * small, non-secret facts of the flow (the invited email and roles).
 */
export const actionToken = tenantTable(
  'action_token',
  {
    kind: text('kind').notNull(),
    tokenHash: text('token_hash').notNull(),
    subjectId: uuid('subject_id').notNull(),
    /** When set, only this session can redeem the token (downloads). */
    sessionId: uuid('session_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    maxUses: integer('max_uses').notNull().default(1),
    uses: integer('uses').notNull().default(0),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'action_token_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    uniqueIndex('action_token_token_hash_key').on(table.tokenHash),
    index('action_token_subject_idx').on(table.tenantId, table.kind, table.subjectId),
    check('action_token_uses_check', sql`${table.uses} between 0 and ${table.maxUses}`),
    check('action_token_max_uses_check', sql`${table.maxUses} >= 1`),
  ],
);

export type ActionTokenRow = typeof actionToken.$inferSelect;
