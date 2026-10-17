/** What the server hands out for one file: where to POST it and the form fields that go with it. */
export interface StoragePost {
  url: string;
  fields: Record<string, string>;
}

export type StorageUploadErrorKind = 'refused' | 'network' | 'cancelled';

/** The upload to storage failed. Never carries the file, the URL or the form fields. */
export class StorageUploadError extends Error {
  readonly kind: StorageUploadErrorKind;
  constructor(kind: StorageUploadErrorKind) {
    super(`storage upload ${kind}`);
    this.name = 'StorageUploadError';
    this.kind = kind;
  }
}

/**
 * Sends a file straight to object storage with the presigned POST the API prepared: the fields in
 * the order given, the file last. It uses XMLHttpRequest because it is the only browser API that
 * reports how much of an upload has left. The request carries no cookies: storage is another
 * origin and has no business with this session.
 *
 * `onProgress` receives a number from 0 to 1, and only when the browser knows the total size.
 */
export function postToStorage(
  post: StoragePost,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', post.url);
    request.withCredentials = false;

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new StorageUploadError('refused'));
    };
    request.onerror = () => {
      reject(new StorageUploadError('network'));
    };
    request.onabort = () => {
      reject(new StorageUploadError('cancelled'));
    };
    signal?.addEventListener('abort', () => {
      request.abort();
    });

    const form = new FormData();
    for (const [name, value] of Object.entries(post.fields)) form.append(name, value);
    form.append('file', file);
    request.send(form);
  });
}
