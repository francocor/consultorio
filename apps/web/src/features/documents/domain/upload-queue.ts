import type { DocumentContentType } from '@consultorio/contracts';

export type UploadStatus =
  /** Picked, waiting for the person to press "Subir". */
  | 'ready'
  /** Asking the server to prepare the upload. */
  | 'registering'
  /** The server says the patient already has this content: waiting for the person to decide. */
  | 'duplicate'
  /** Sending the file to storage. */
  | 'uploading'
  /** Telling the server the file arrived. */
  | 'confirming'
  /** Confirmed. The server is scanning it. */
  | 'done'
  | 'failed';

export type UploadFailure =
  /** The API refused the request (a rule, a permission, a read-only organization). */
  | 'api'
  /** Storage refused the file (too large, wrong type, expired link). */
  | 'refused'
  | 'network';

export interface UploadItem {
  key: string;
  file: File;
  name: string;
  size: number;
  contentType: DocumentContentType;
  status: UploadStatus;
  /** From 0 to 1 while `uploading`. */
  progress: number;
  documentId?: string;
  duplicateOf?: { id: string; name: string };
  error?: UploadFailure;
  /** The translation key the API gave for a refusal, to show its explanation. */
  errorKey?: string;
}

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `upload-${String(counter)}`;
}

export function addItems(
  queue: readonly UploadItem[],
  entries: readonly { file: File; contentType: DocumentContentType }[],
): UploadItem[] {
  return [
    ...queue,
    ...entries.map(({ file, contentType }): UploadItem => ({
      key: nextKey(),
      file,
      name: file.name,
      size: file.size,
      contentType,
      status: 'ready',
      progress: 0,
    })),
  ];
}

export function patchItem(
  queue: readonly UploadItem[],
  key: string,
  patch: Partial<UploadItem>,
): UploadItem[] {
  return queue.map((item) => (item.key === key ? { ...item, ...patch } : item));
}

export function removeItem(queue: readonly UploadItem[], key: string): UploadItem[] {
  return queue.filter((item) => item.key !== key);
}

const IN_FLIGHT: readonly UploadStatus[] = ['registering', 'uploading', 'confirming', 'duplicate'];

/** The button works when something is waiting (or failed, to try again) and nothing is mid-way. */
export function canStart(queue: readonly UploadItem[]): boolean {
  if (queue.some((item) => IN_FLIGHT.includes(item.status))) return false;
  return queue.some((item) => item.status === 'ready' || item.status === 'failed');
}

/** Every item reached an end: confirmed, or failed. */
export function isFinished(queue: readonly UploadItem[]): boolean {
  return (
    queue.length > 0 && queue.every((item) => item.status === 'done' || item.status === 'failed')
  );
}

export function summarize(queue: readonly UploadItem[]): {
  done: number;
  failed: number;
  waiting: number;
} {
  return {
    done: queue.filter((item) => item.status === 'done').length,
    failed: queue.filter((item) => item.status === 'failed').length,
    waiting: queue.filter((item) => item.status !== 'done' && item.status !== 'failed').length,
  };
}
