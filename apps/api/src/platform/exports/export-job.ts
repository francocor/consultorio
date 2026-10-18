import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { Tx } from '../db/tenant-context.js';
import { JobPayload } from '../jobs/boss.js';
import { defineJob, type JobDefinition } from '../jobs/define-job.js';
import type { PdfBranding } from '../pdf/render.js';
import { tenantKey, type ObjectStorage } from '../storage/object-storage.js';

import { buildExportFile } from './build-file.js';
import type { ExportFileFormat, ExportTable } from './types.js';

/** The queue of the export job (classified `export` in the read-only policy: it runs for a read-only tenant). */
export const EXPORT_BUILD_JOB = 'export.build';

/** Something an organization can export: builds the table of what was asked for. */
export interface ExportSource {
  kind: string;
  /** The start of the name of the file, in the language of the product: `cobros`, `pagos`. */
  fileBase: string;
  /** Reads the data in the transaction of the job (row level security applies to the organization). */
  build(tx: Tx, filters: Readonly<Record<string, unknown>>): Promise<ExportTable>;
}

/** What the job needs to know about a request, and a way to say how it ended. */
export interface ExportRequestRecord {
  id: string;
  kind: string;
  format: ExportFileFormat;
  filters: Readonly<Record<string, unknown>>;
  /** Only a `queued` request is built: a redelivery of a finished one does nothing. */
  status: string;
}

export interface ExportStore {
  load(tx: Tx, id: string): Promise<ExportRequestRecord | null>;
  ready(
    tx: Tx,
    id: string,
    file: { objectKey: string; fileName: string; sizeBytes: number; rowCount: number; at: Date },
  ): Promise<void>;
  /** Nothing matched: no file is made, and the request says so. */
  empty(tx: Tx, id: string, at: Date): Promise<void>;
  failed(tx: Tx, id: string, code: string, at: Date): Promise<void>;
}

export interface ExportJobDeps {
  sources: readonly ExportSource[];
  store: ExportStore;
  storage: ObjectStorage;
  /** The name and details the header of a PDF shows. */
  branding(tx: Tx): Promise<PdfBranding>;
  clock: () => Date;
}

const Payload = JobPayload.extend({ exportId: z.uuid() });

/** `cobros-20310512.csv`: a name made by the product, with nothing a person typed in it. */
function fileNameFor(base: string, at: Date, extension: string): string {
  const day = at.toISOString().slice(0, 10).replaceAll('-', '');
  return `${base}-${day}.${extension}`;
}

/**
 * `export.build`: builds the file of one export request. It stores the result at
 * `t/{tenantId}/exports/{uuid}`; a request with nothing to list ends `empty` and makes no file; a
 * request whose data cannot be built ends `failed` with a code (it is not retried, asking again
 * makes a new request). A failure of the storage is thrown, so the queue retries it. Idempotent: a
 * request that is not queued is left alone.
 */
export function createExportJob(deps: ExportJobDeps): JobDefinition<z.infer<typeof Payload>> {
  return defineJob({
    name: EXPORT_BUILD_JOB,
    category: 'export',
    payload: Payload,
    handler: async ({ tx, tenantId, payload }) => {
      const request = await deps.store.load(tx, payload.exportId);
      if (request?.status !== 'queued') return;
      const now = deps.clock();

      const source = deps.sources.find((candidate) => candidate.kind === request.kind);
      if (!source) {
        await deps.store.failed(tx, request.id, 'unknown_kind', now);
        return;
      }

      let table: ExportTable;
      try {
        table = await source.build(tx, request.filters);
      } catch {
        await deps.store.failed(tx, request.id, 'build_failed', now);
        return;
      }
      if (table.rows.length === 0) {
        await deps.store.empty(tx, request.id, now);
        return;
      }

      const file = await buildExportFile(table, request.format, {
        branding: await deps.branding(tx),
        createdAt: now,
      });
      const objectKey = tenantKey(tenantId, 'exports', randomUUID());
      await deps.storage.put(tenantId, objectKey, {
        body: file.bytes,
        contentType: file.contentType,
        contentLength: file.bytes.length,
      });
      await deps.store.ready(tx, request.id, {
        objectKey,
        fileName: fileNameFor(source.fileBase, now, file.extension),
        sizeBytes: file.bytes.length,
        rowCount: table.rows.filter((row) => row.emphasis === undefined).length,
        at: now,
      });
    },
  });
}
