import { mkdtemp, rm } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tenantKey } from '../../platform/storage/object-storage.js';

import { createFsObjectStorage } from './index.js';

/**
 * A document on a PC that loses power right after the rename must still be there, whole: the bytes are
 * forced to the disk before the name that points at them appears. The calls are recorded in order.
 */
const events: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push(`sync ${basename(path)}`);
        await sync();
      };
      return handle;
    },
    rename: async (from: string, to: string) => {
      events.push(`rename ${basename(from)} -> ${basename(to)}`);
      await actual.rename(from, to);
    },
  };
});

let dir: string;

beforeEach(async () => {
  events.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'consulvia-fs-durable-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TENANT = '0197f4c2-0000-7000-8000-000000000001';

describe('the disk storage forces what it writes to the disk before it renames it', () => {
  it('syncs the bytes and the content type of a buffer before each rename', async () => {
    const storage = createFsObjectStorage({ dir, uploadSecret: 'u'.repeat(40) });

    await storage.put(TENANT, tenantKey(TENANT, 'docs/a.pdf'), {
      body: Buffer.from('hello'),
      contentType: 'application/pdf',
    });

    const syncs = events.filter((event) => event.startsWith('sync '));
    const renames = events.filter((event) => event.startsWith('rename '));
    expect(syncs).toHaveLength(2);
    expect(renames).toHaveLength(2);
    // Every temporary file is synced before it is renamed.
    for (const rename of renames) {
      const from = /^rename (\S+) ->/.exec(rename)?.[1] ?? '';
      expect(events.indexOf(`sync ${from}`), rename).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(`sync ${from}`), rename).toBeLessThan(events.indexOf(rename));
    }
  });

  it('does the same for a streamed body', async () => {
    const storage = createFsObjectStorage({ dir, uploadSecret: 'u'.repeat(40) });

    await storage.put(TENANT, tenantKey(TENANT, 'docs/b.pdf'), {
      body: Readable.from([Buffer.from('he'), Buffer.from('llo')]),
      contentType: 'application/pdf',
    });

    expect(events.filter((event) => event.startsWith('sync '))).toHaveLength(2);
  });
});
