import { sql } from 'drizzle-orm';
import pg from 'pg';
import { inject } from 'vitest';

import type { Tx } from '../../src/platform/db/tenant-context.js';

import { eventually } from './eventually.js';

/** A latch: `opened` resolves, with the value, when `open()` is called. */
export function gate<T = void>(): { open: (value: T) => void; opened: Promise<T> } {
  let open!: (value: T) => void;
  const opened = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** The process id of the database connection a transaction runs on. */
export async function backendPid(tx: Tx): Promise<number> {
  const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('no backend pid');
  return pid;
}

/**
 * Waits until at least `count` backends of the test database are waiting for a lock held by the
 * backend `holder` (its process id, from `backendPid`), and returns their process ids. A race test
 * uses it to know the second connection has reached the point where it blocks BEHIND THE
 * TRANSACTION THE TEST HOLDS, before it lets the first one finish, so the order of events is the one
 * the test means and not a matter of timing. A waiter that waits for something else (another test's
 * lock, a queue ahead of it) does not count: it names who it waits for.
 */
export async function waitForLockWaiters(holder: number, count = 1): Promise<number[]> {
  const admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  try {
    return await eventually(async () => {
      const result = await admin.query<{ pid: number }>(
        `select a.pid from pg_stat_activity a
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and $1::int = any(pg_blocking_pids(a.pid))
          order by a.pid`,
        [holder],
      );
      return result.rows.length >= count ? result.rows.map((row) => row.pid) : undefined;
    });
  } finally {
    await admin.end();
  }
}
