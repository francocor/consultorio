import { PgBoss } from 'pg-boss';

import { JOBS_SCHEMA, QUEUES, type QueueDefinition } from './queues.js';

/**
 * Installs (or upgrades) the pg-boss schema and creates the queues. Runs as the schema OWNER from
 * `db:migrate`, because the runtime role cannot create tables. pg-boss' own installer decides what
 * to do for the version in `package.json`, so a library upgrade is applied by the next deploy.
 * Safe to run any number of times.
 *
 * @param extraQueues queues to create besides the application's own (tests add theirs)
 */
export async function installJobs(
  ownerDatabaseUrl: string,
  extraQueues: readonly QueueDefinition[] = [],
): Promise<void> {
  const boss = new PgBoss({
    connectionString: ownerDatabaseUrl,
    schema: JOBS_SCHEMA,
    migrate: true,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on('error', () => undefined);
  await boss.start();
  try {
    for (const queue of [...QUEUES, ...extraQueues]) {
      await boss.createQueue(queue.name, queue.options);
    }
  } finally {
    await boss.stop({ graceful: false });
  }
}
