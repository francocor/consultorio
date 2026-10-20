import { createHash } from 'node:crypto';

import type {
  ArchiveGetResult,
  ArchiveHeadResult,
  ArchiveListResult,
  ArchiveObjectInfo,
  ArchivePutOptions,
  ArchivePutResult,
  ArchiveRemoveResult,
  ArchiveStore,
} from '../../modules/tenancy/archive/ports.js';

/**
 * The in-memory archive store for demo organizations and unit tests: write once, checksum checked,
 * retention honoured, and no removal for a routine role. The local MinIO adapter (Track C,
 * `adapters/archive-local`) gets the same behaviour from Object Lock; both pass the shared suite
 * `adapters/archive-store.contract.ts` that Track C writes.
 */

export interface FakeArchiveStore extends ArchiveStore {
  readonly simulated: true;
  /** `down` makes every call ask to try again; nothing is stored or read meanwhile. */
  setMode(mode: 'ok' | 'down'): void;
  /** Forgets everything and goes back to the `ok` mode. */
  reset(): void;
}

const SERVICE_DOWN_MESSAGE =
  'El almacén de archivo no está disponible. Intente nuevamente más tarde.';
const CHECKSUM_MESSAGE = 'Los datos no coinciden con la suma de verificación enviada.';
const LOCKED_MESSAGE = 'El objeto ya existe con otro contenido y no se puede reemplazar.';

const abortError = () => new DOMException('The call was aborted.', 'AbortError');

interface Stored {
  info: ArchiveObjectInfo;
  body: Uint8Array;
}

export function createFakeArchiveStore(options: { clock?: () => Date } = {}): FakeArchiveStore {
  const clock = options.clock ?? (() => new Date());
  let mode: 'ok' | 'down' = 'ok';
  let objects = new Map<string, Stored>();

  const down = () => ({ status: 'retryable', message: SERVICE_DOWN_MESSAGE }) as const;

  return {
    simulated: true,
    setMode(next) {
      mode = next;
    },
    reset() {
      mode = 'ok';
      objects = new Map();
    },

    put(key: string, body: Uint8Array, put: ArchivePutOptions, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (mode === 'down') {
        return Promise.resolve<ArchivePutResult>({ ...down(), outcomeUnknown: false });
      }
      const digest = createHash('sha256').update(body).digest('hex');
      if (digest !== put.sha256) {
        return Promise.resolve<ArchivePutResult>({ status: 'rejected', message: CHECKSUM_MESSAGE });
      }
      const known = objects.get(key);
      if (known) {
        return Promise.resolve<ArchivePutResult>(
          known.info.sha256 === digest
            ? { status: 'already_stored', object: { ...known.info } }
            : { status: 'locked', message: LOCKED_MESSAGE },
        );
      }
      const info: ArchiveObjectInfo = {
        key,
        sizeBytes: body.byteLength,
        sha256: digest,
        retainUntil: put.retainUntil.toISOString(),
        storedAt: clock().toISOString(),
      };
      objects.set(key, { info, body: new Uint8Array(body) });
      return Promise.resolve<ArchivePutResult>({ status: 'stored', object: { ...info } });
    },

    head(key: string, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (mode === 'down') return Promise.resolve<ArchiveHeadResult>(down());
      const stored = objects.get(key);
      return Promise.resolve<ArchiveHeadResult>(
        stored ? { status: 'found', object: { ...stored.info } } : { status: 'unknown' },
      );
    },

    get(key: string, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (mode === 'down') return Promise.resolve<ArchiveGetResult>(down());
      const stored = objects.get(key);
      return Promise.resolve<ArchiveGetResult>(
        stored
          ? { status: 'found', object: { ...stored.info }, body: new Uint8Array(stored.body) }
          : { status: 'unknown' },
      );
    },

    list(prefix: string, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (mode === 'down') return Promise.resolve<ArchiveListResult>(down());
      return Promise.resolve<ArchiveListResult>({
        status: 'ok',
        objects: [...objects.values()]
          .filter((stored) => stored.info.key.startsWith(prefix))
          .map((stored) => ({ ...stored.info })),
      });
    },

    remove(key: string, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (mode === 'down') return Promise.resolve<ArchiveRemoveResult>(down());
      const stored = objects.get(key);
      if (!stored) return Promise.resolve<ArchiveRemoveResult>({ status: 'unknown' });
      const retained = Date.parse(stored.info.retainUntil) > clock().getTime();
      return Promise.resolve<ArchiveRemoveResult>({
        status: 'refused',
        reason: retained ? 'retention' : 'not_permitted',
      });
    },
  };
}
