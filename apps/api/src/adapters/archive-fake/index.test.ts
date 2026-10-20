import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createFakeArchiveStore } from './index.js';

const NOW = new Date('2026-10-20T15:00:00.000Z');
const IN_TEN_YEARS = new Date('2036-10-20T15:00:00.000Z');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);

function store() {
  return createFakeArchiveStore({ clock: () => NOW });
}

describe('the in-memory archive store', () => {
  it('stores an object and gives it back byte for byte, with its checksum and retention', async () => {
    const archive = store();
    const body = bytes('ciphertext-of-a-tenant');

    const put = await archive.put('t/org-1/part-1', body, {
      sha256: sha256(body),
      retainUntil: IN_TEN_YEARS,
    });
    const got = await archive.get('t/org-1/part-1');

    expect(put).toMatchObject({
      status: 'stored',
      object: {
        key: 't/org-1/part-1',
        sizeBytes: body.byteLength,
        sha256: sha256(body),
        retainUntil: IN_TEN_YEARS.toISOString(),
      },
    });
    expect(got.status).toBe('found');
    expect(got.status === 'found' ? [...got.body] : []).toEqual([...body]);
    expect(await archive.head('t/org-1/part-1')).toMatchObject({ status: 'found' });
    expect(await archive.head('t/org-1/nothing')).toEqual({ status: 'unknown' });
  });

  it('refuses bytes that do not match the checksum they were sent with, and stores nothing', async () => {
    const archive = store();
    const body = bytes('ciphertext');

    const result = await archive.put('t/org-1/part-1', body, {
      sha256: sha256(bytes('something else')),
      retainUntil: IN_TEN_YEARS,
    });

    expect(result.status).toBe('rejected');
    expect(await archive.head('t/org-1/part-1')).toEqual({ status: 'unknown' });
  });

  it('is write once: the same bytes again are a harmless retry, other bytes under the key are locked out', async () => {
    const archive = store();
    const body = bytes('first');
    await archive.put('t/org-1/part-1', body, { sha256: sha256(body), retainUntil: IN_TEN_YEARS });

    const retry = await archive.put('t/org-1/part-1', body, {
      sha256: sha256(body),
      retainUntil: IN_TEN_YEARS,
    });
    const other = bytes('second');
    const overwrite = await archive.put('t/org-1/part-1', other, {
      sha256: sha256(other),
      retainUntil: IN_TEN_YEARS,
    });

    expect(retry.status).toBe('already_stored');
    expect(overwrite.status).toBe('locked');
    const got = await archive.get('t/org-1/part-1');
    expect(got.status === 'found' ? new TextDecoder().decode(got.body) : '').toBe('first');
  });

  it('refuses to remove an object inside its retention, and a routine role never removes one', async () => {
    const archive = store();
    const body = bytes('kept');
    await archive.put('t/org-1/part-1', body, { sha256: sha256(body), retainUntil: IN_TEN_YEARS });
    await archive.put('t/org-1/old', body, { sha256: sha256(body), retainUntil: NOW });

    expect(await archive.remove('t/org-1/part-1')).toEqual({
      status: 'refused',
      reason: 'retention',
    });
    // Retention over: the routine role is still not allowed; the bucket policy and the legal erasure are.
    expect(await archive.remove('t/org-1/old')).toEqual({
      status: 'refused',
      reason: 'not_permitted',
    });
    expect(await archive.remove('t/org-1/nothing')).toEqual({ status: 'unknown' });
    expect(await archive.head('t/org-1/part-1')).toMatchObject({ status: 'found' });
    expect(await archive.head('t/org-1/old')).toMatchObject({ status: 'found' });
  });

  it('lists the objects under a prefix, oldest first, and none under another', async () => {
    const archive = store();
    for (const key of ['t/org-1/a', 't/org-1/b', 't/org-2/a']) {
      const body = bytes(key);
      await archive.put(key, body, { sha256: sha256(body), retainUntil: IN_TEN_YEARS });
    }

    const mine = await archive.list('t/org-1/');
    const none = await archive.list('t/org-9/');

    expect(mine.status === 'ok' ? mine.objects.map((entry) => entry.key) : []).toEqual([
      't/org-1/a',
      't/org-1/b',
    ]);
    expect(none).toEqual({ status: 'ok', objects: [] });
  });

  it('asks to try again while it is down and stores nothing; gives up an aborted call', async () => {
    const archive = store();
    const body = bytes('x');
    archive.setMode('down');

    const put = await archive.put('t/org-1/part-1', body, {
      sha256: sha256(body),
      retainUntil: IN_TEN_YEARS,
    });
    expect(put).toMatchObject({ status: 'retryable', outcomeUnknown: false });
    expect((await archive.head('t/org-1/part-1')).status).toBe('retryable');

    archive.setMode('ok');
    expect(await archive.head('t/org-1/part-1')).toEqual({ status: 'unknown' });
    await expect(
      archive.put(
        't/org-1/part-1',
        body,
        { sha256: sha256(body), retainUntil: IN_TEN_YEARS },
        AbortSignal.abort(),
      ),
    ).rejects.toBeDefined();
    expect(await archive.head('t/org-1/part-1')).toEqual({ status: 'unknown' });
  });
});
