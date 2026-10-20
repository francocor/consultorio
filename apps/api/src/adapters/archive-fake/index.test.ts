import { describeArchiveStoreContract } from '../archive-store.contract.js';

import { createFakeArchiveStore } from './index.js';

/**
 * The in-memory archive store is held to the same contract as the MinIO adapter: write once,
 * checksum checked, retention honoured, no removal for the routine role, abortable, and honest when
 * it is down. It keeps its own clock, so the retention is crossed by moving it.
 */
describeArchiveStoreContract({
  name: 'in-memory fake',
  make: () => {
    let now = new Date('2026-10-20T15:00:00.000Z');
    const store = createFakeArchiveStore({ clock: () => now });
    return Promise.resolve({
      store,
      retainFor: (ms) => new Date(now.getTime() + ms),
      pastShortRetention: () => {
        now = new Date(now.getTime() + 60_000);
        return Promise.resolve();
      },
      setDown: (down) => {
        store.setMode(down ? 'down' : 'ok');
      },
    });
  },
});
