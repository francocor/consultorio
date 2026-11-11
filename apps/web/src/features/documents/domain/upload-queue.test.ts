import { describe, expect, it } from 'vitest';

import {
  addItems,
  canStart,
  isFinished,
  patchItem,
  removeItem,
  summarize,
  type UploadItem,
} from './upload-queue.js';

const PDF = 'application/pdf';
const file = (name: string, size = 1000) => new File([new Uint8Array(size)], name, { type: PDF });

function queueOf(...names: string[]): UploadItem[] {
  return addItems(
    [],
    names.map((name) => ({ file: file(name), contentType: PDF })),
  );
}

describe('adding files to the queue', () => {
  it('keeps the order, starts every file as ready, and gives each a key of its own', () => {
    const queue = queueOf('a.pdf', 'b.pdf', 'a.pdf');

    expect(queue.map((item) => item.name)).toEqual(['a.pdf', 'b.pdf', 'a.pdf']);
    expect(queue.every((item) => item.status === 'ready' && item.progress === 0)).toBe(true);
    expect(new Set(queue.map((item) => item.key)).size).toBe(3);
  });

  it('adds to an existing queue without touching what is already there', () => {
    const first = queueOf('a.pdf');
    const second = addItems(first, [{ file: file('b.pdf'), contentType: PDF }]);

    expect(second.map((item) => item.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(second[0]).toBe(first[0]);
  });
});

describe('changing one item', () => {
  it('patches only the item with that key and leaves the others as they were', () => {
    const queue = queueOf('a.pdf', 'b.pdf');
    const [a, b] = queue;

    const next = patchItem(queue, a?.key ?? '', { status: 'uploading', progress: 0.4 });

    expect(next[0]).toMatchObject({ name: 'a.pdf', status: 'uploading', progress: 0.4 });
    expect(next[1]).toBe(b);
  });

  it('removes an item by key', () => {
    const queue = queueOf('a.pdf', 'b.pdf');

    expect(removeItem(queue, queue[0]?.key ?? '').map((item) => item.name)).toEqual(['b.pdf']);
    expect(removeItem(queue, 'nope')).toHaveLength(2);
  });
});

describe('what the dialog can do right now', () => {
  it('can start when something is ready and nothing is in flight', () => {
    const queue = queueOf('a.pdf', 'b.pdf');

    expect(canStart(queue)).toBe(true);
    expect(canStart([])).toBe(false);
    expect(canStart(patchItem(queue, queue[0]?.key ?? '', { status: 'uploading' }))).toBe(false);
    expect(canStart(patchItem(queue, queue[0]?.key ?? '', { status: 'duplicate' }))).toBe(false);
  });

  it('can start again after a failure, retrying only what failed', () => {
    const queue = queueOf('a.pdf');
    const failed = patchItem(queue, queue[0]?.key ?? '', { status: 'failed', error: 'network' });

    expect(canStart(failed)).toBe(true);
  });

  it('is finished when every item is done, or failed or refused, and not before', () => {
    const queue = queueOf('a.pdf', 'b.pdf');
    const [a, b] = queue;

    expect(isFinished(queue)).toBe(false);
    const oneDone = patchItem(queue, a?.key ?? '', { status: 'done' });
    expect(isFinished(oneDone)).toBe(false);
    expect(
      isFinished(patchItem(oneDone, b?.key ?? '', { status: 'failed', error: 'refused' })),
    ).toBe(true);
    expect(isFinished([])).toBe(false);
  });

  it('counts the outcomes for the message at the end', () => {
    let queue = queueOf('a.pdf', 'b.pdf', 'c.pdf');
    queue = patchItem(queue, queue[0]?.key ?? '', { status: 'done' });
    queue = patchItem(queue, queue[1]?.key ?? '', { status: 'failed', error: 'network' });

    expect(summarize(queue)).toEqual({ done: 1, failed: 1, waiting: 1 });
  });
});
