import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ArchiveStore } from '../modules/tenancy/archive/ports.js';

/**
 * The contract of the `ArchiveStore` port (design section 6, "one shared suite per port"). The
 * in-memory fake and the local MinIO adapter (a bucket with Object Lock in governance mode) must pass
 * it, and so must the S3 adapter of the deferred slice: what the retention archive relies on is
 * written here once.
 *
 * What the archive relies on:
 * - an object is written ONCE: the same bytes again are a harmless retry, other bytes under the key
 *   are never an overwrite;
 * - a corrupted upload never lands: the bytes must match the checksum they were sent with;
 * - nothing is removed through this port, inside the retention period or after it: removal exists
 *   only so the immutability can be proven, and the legal erasure has a credential and a path of its
 *   own (`archive-local/erasure.ts`);
 * - a call can be given up (`AbortSignal`), and a store that is down asks to try again instead of
 *   pretending.
 *
 * Every test uses a prefix of its own, so a target that keeps its objects (a bucket) needs no cleanup.
 */

/** How long the short retention of a test lasts on a target that cannot move its clock. */
export const SHORT_RETENTION_MS = 3000;

export interface ArchiveHarness {
  store: ArchiveStore;
  /** The instant `ms` from now on the target's own clock (what a retention period is counted on). */
  retainFor: (ms: number) => Date;
  /**
   * Lets an object stored with `retainFor(SHORT_RETENTION_MS)` leave its retention: the fake moves
   * its clock, a bucket waits for the real time to pass.
   */
  pastShortRetention: () => Promise<void>;
  /** Only for a target that can be taken down on demand (the fake). */
  setDown?: (down: boolean) => void;
  close?: () => Promise<void>;
}

export interface ArchiveContractTarget {
  name: string;
  make(): Promise<ArchiveHarness>;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);
const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;
/** Object stores keep seconds; the contract compares the retention at that resolution. */
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const prefix = () => `contract/${randomUUID()}/`;

export function describeArchiveStoreContract(target: ArchiveContractTarget): void {
  describe(`the archive store contract: ${target.name}`, () => {
    it('stores an object and gives it back byte for byte, with its checksum, size and retention', async () => {
      const { store, retainFor, close } = await target.make();
      try {
        const body = bytes('ciphertext-of-a-tenant');
        const key = `${prefix()}part-1`;
        const until = retainFor(TEN_YEARS_MS);

        const put = await store.put(key, body, { sha256: sha256(body), retainUntil: until });
        const got = await store.get(key);
        const head = await store.head(key);

        expect(put.status).toBe('stored');
        expect(put.status === 'stored' ? put.object : null).toMatchObject({
          key,
          sizeBytes: body.byteLength,
          sha256: sha256(body),
        });
        expect(got.status).toBe('found');
        expect(got.status === 'found' ? [...got.body] : []).toEqual([...body]);
        expect(head.status === 'found' ? head.object.sha256 : '').toBe(sha256(body));
        expect(head.status === 'found' ? seconds(head.object.retainUntil) : 0).toBe(
          Math.floor(until.getTime() / 1000),
        );
      } finally {
        await close?.();
      }
    });

    it('answers "unknown" for a key that was never written, on head and on get', async () => {
      const { store, close } = await target.make();
      try {
        const key = `${prefix()}nothing`;

        expect(await store.head(key)).toEqual({ status: 'unknown' });
        expect(await store.get(key)).toEqual({ status: 'unknown' });
      } finally {
        await close?.();
      }
    });

    it('refuses bytes that do not match the checksum they were sent with, and stores nothing', async () => {
      const { store, retainFor, close } = await target.make();
      try {
        const key = `${prefix()}part-1`;

        const result = await store.put(key, bytes('ciphertext'), {
          sha256: sha256(bytes('something else')),
          retainUntil: retainFor(TEN_YEARS_MS),
        });

        expect(result.status).toBe('rejected');
        expect(await store.head(key)).toEqual({ status: 'unknown' });
      } finally {
        await close?.();
      }
    });

    it('is write once: the same bytes again are a retry, other bytes under the key are locked out', async () => {
      const { store, retainFor, close } = await target.make();
      try {
        const key = `${prefix()}part-1`;
        const first = bytes('first');
        const second = bytes('second');
        await store.put(key, first, {
          sha256: sha256(first),
          retainUntil: retainFor(TEN_YEARS_MS),
        });

        const retry = await store.put(key, first, {
          sha256: sha256(first),
          retainUntil: retainFor(TEN_YEARS_MS),
        });
        const overwrite = await store.put(key, second, {
          sha256: sha256(second),
          retainUntil: retainFor(TEN_YEARS_MS),
        });

        expect(retry.status).toBe('already_stored');
        expect(overwrite.status).toBe('locked');
        const got = await store.get(key);
        expect(got.status === 'found' ? new TextDecoder().decode(got.body) : '').toBe('first');
        // Nothing was added under the key: the archive holds one version of it.
        expect(got.status === 'found' ? got.object.versions : 0).toBe(1);
      } finally {
        await close?.();
      }
    });

    it('stores a large object whole, and another of a different size beside it', async () => {
      const { store, retainFor, close } = await target.make();
      try {
        const base = prefix();
        const large = new Uint8Array(6 * 1024 * 1024).map((_, index) => (index * 31) % 251);
        const small = bytes('x');

        const one = await store.put(`${base}large`, large, {
          sha256: sha256(large),
          retainUntil: retainFor(TEN_YEARS_MS),
        });
        const two = await store.put(`${base}small`, small, {
          sha256: sha256(small),
          retainUntil: retainFor(TEN_YEARS_MS),
        });
        const got = await store.get(`${base}large`);

        expect(one.status).toBe('stored');
        expect(two.status).toBe('stored');
        expect(got.status === 'found' ? sha256(got.body) : '').toBe(sha256(large));
      } finally {
        await close?.();
      }
    });

    it('refuses to remove an object inside its retention, and the object stays', async () => {
      const { store, retainFor, close } = await target.make();
      try {
        const key = `${prefix()}kept`;
        const body = bytes('kept');
        await store.put(key, body, { sha256: sha256(body), retainUntil: retainFor(TEN_YEARS_MS) });

        const removal = await store.remove(key);

        expect(removal).toEqual({ status: 'refused', reason: 'retention' });
        expect(await store.head(key)).toMatchObject({ status: 'found' });
        expect(await store.remove(`${prefix()}nothing`)).toEqual({ status: 'unknown' });
      } finally {
        await close?.();
      }
    });

    it('never removes an object through this role, not even after the retention is over', async () => {
      const { store, retainFor, pastShortRetention, close } = await target.make();
      try {
        const key = `${prefix()}old`;
        const body = bytes('old');
        await store.put(key, body, {
          sha256: sha256(body),
          retainUntil: retainFor(SHORT_RETENTION_MS),
        });
        await pastShortRetention();

        const removal = await store.remove(key);

        // The retention is over, but the routine role is still not the one that erases: that is the
        // legal-erasure credential, with its own procedure.
        expect(removal).toEqual({ status: 'refused', reason: 'not_permitted' });
        expect(await store.head(key)).toMatchObject({ status: 'found' });
      } finally {
        await close?.();
      }
    });

    it('lists the objects under a prefix, in the order they were written (then by key), and none under another', async () => {
      const { store, retainFor, close } = await target.make();
      try {
        const base = prefix();
        for (const name of ['a', 'b', 'c']) {
          const body = bytes(name);
          await store.put(`${base}${name}`, body, {
            sha256: sha256(body),
            retainUntil: retainFor(TEN_YEARS_MS),
          });
        }

        const mine = await store.list(base);
        const none = await store.list(prefix());

        expect(mine.status === 'ok' ? mine.objects.map((entry) => entry.key) : []).toEqual([
          `${base}a`,
          `${base}b`,
          `${base}c`,
        ]);
        expect(none).toEqual({ status: 'ok', objects: [] });
      } finally {
        await close?.();
      }
    });

    it('gives up an aborted call and stores nothing', async () => {
      const { store, retainFor, close } = await target.make();
      try {
        const key = `${prefix()}part-1`;
        const body = bytes('x');

        await expect(
          store.put(
            key,
            body,
            { sha256: sha256(body), retainUntil: retainFor(TEN_YEARS_MS) },
            AbortSignal.abort(),
          ),
        ).rejects.toBeDefined();

        expect(await store.head(key)).toEqual({ status: 'unknown' });
      } finally {
        await close?.();
      }
    });

    it('asks to try again while it is down and stores nothing', async () => {
      const harness = await target.make();
      try {
        if (!harness.setDown) return;
        const key = `${prefix()}part-1`;
        const body = bytes('x');
        harness.setDown(true);

        const put = await harness.store.put(key, body, {
          sha256: sha256(body),
          retainUntil: harness.retainFor(TEN_YEARS_MS),
        });
        const head = await harness.store.head(key);
        harness.setDown(false);

        expect(put).toMatchObject({ status: 'retryable', outcomeUnknown: false });
        expect(head.status).toBe('retryable');
        expect(await harness.store.head(key)).toEqual({ status: 'unknown' });
      } finally {
        await harness.close?.();
      }
    });
  });
}
