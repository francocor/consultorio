import pg from 'pg';
import { inject } from 'vitest';

import { eventually } from './eventually.js';

/** A latch: `opened` resolves when `open()` is called. */
export function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * Waits until at least `count` backends of the test database are waiting for a lock held by
 * another transaction. A race test uses it to know the second connection has reached the point
 * where it blocks before it lets the first one finish, so the order of events is the one the test
 * means and not a matter of timing.
 */
export async function waitForLockWaiters(count = 1): Promise<void> {
  const admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  try {
    await eventually(async () => {
      const result = await admin.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      return (result.rows[0]?.waiting ?? 0) >= count ? true : undefined;
    });
  } finally {
    await admin.end();
  }
}
