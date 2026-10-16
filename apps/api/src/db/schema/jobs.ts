import { timestamp, unique, uuid, text, foreignKey } from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { tenant } from './tenant.js';

/**
 * One row per job a tenant's handler has completed. It is written in the SAME transaction as the
 * handler's own writes, so the job's effects and this marker commit or roll back together. If the
 * queue delivers the same job again after a crash between commit and acknowledgement, the marker
 * is already there and the handler is skipped: jobs are idempotent.
 */
export const jobExecution = tenantTable(
  'job_execution',
  {
    queue: text('queue').notNull(),
    jobId: uuid('job_id').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'job_execution_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    unique('job_execution_tenant_id_queue_job_id_key').on(table.tenantId, table.queue, table.jobId),
  ],
);
