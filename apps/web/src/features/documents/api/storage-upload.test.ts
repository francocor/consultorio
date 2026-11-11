import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { postToStorage, StorageUploadError } from './storage-upload.js';

/** Just enough of XMLHttpRequest to drive an upload from a test. */
class FakeXhr {
  static last: FakeXhr | undefined;
  method = '';
  url = '';
  status = 0;
  body: FormData | null = null;
  aborted = false;
  withCredentials = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload: {
    onprogress:
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  finish(status: number) {
    this.status = status;
    this.onload?.();
  }
}

beforeEach(() => {
  FakeXhr.last = undefined;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const OBJECT_PATH = 't/abc/quarantine/doc';
const post = {
  url: 'https://files.example.test/bucket',
  fields: {
    key: OBJECT_PATH,
    'Content-Type': 'application/pdf',
    policy: 'p',
    'X-Amz-Signature': 's',
  },
};
const pdf = () => new File(['%PDF-1.4'], 'informe.pdf', { type: 'application/pdf' });

describe('postToStorage: the browser sends the file straight to storage', () => {
  it('posts every field the server handed out, in order, and the file last', async () => {
    const done = postToStorage(post, pdf(), () => undefined);
    const xhr = FakeXhr.last;
    xhr?.finish(204);
    await done;

    expect(xhr?.method).toBe('POST');
    expect(xhr?.url).toBe(post.url);
    const names = [...(xhr?.body?.keys() ?? [])];
    expect(names).toEqual(['key', 'Content-Type', 'policy', 'X-Amz-Signature', 'file']);
    expect(xhr?.body?.get('key')).toBe(OBJECT_PATH);
    expect(xhr?.body?.get('file')).toBeInstanceOf(File);
    // A storage service on another origin must not receive the cookies of this one.
    expect(xhr?.withCredentials).toBe(false);
  });

  it('reports progress as a fraction, only when the browser knows the total', async () => {
    const seen: number[] = [];
    const done = postToStorage(post, pdf(), (fraction) => seen.push(fraction));
    const xhr = FakeXhr.last;

    xhr?.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    xhr?.upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 });
    xhr?.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    xhr?.finish(200);
    await done;

    expect(seen).toEqual([0.25, 1]);
  });

  it.each([403, 400, 500])(
    'rejects with the storage refusal when the answer is %i',
    async (status) => {
      const done = postToStorage(post, pdf(), () => undefined);
      FakeXhr.last?.finish(status);

      await expect(done).rejects.toMatchObject({ name: 'StorageUploadError', kind: 'refused' });
    },
  );

  it('rejects when the network fails, and when the upload is cancelled', async () => {
    const failing = postToStorage(post, pdf(), () => undefined);
    FakeXhr.last?.onerror?.();
    await expect(failing).rejects.toMatchObject({ kind: 'network' });

    const controller = new AbortController();
    const cancelled = postToStorage(post, pdf(), () => undefined, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(StorageUploadError);
    await expect(cancelled).rejects.toMatchObject({ kind: 'cancelled' });
    expect(FakeXhr.last?.aborted).toBe(true);
  });
});
