import type { Tx } from '../../../platform/db/tenant-context.js';

export type ExportKind = 'administrative' | 'clinical';

export interface ExportContext {
  /** Transaction already bound to the exporting tenant (and professional, for clinical parts). */
  tx: Tx;
  tenantId: string;
  /** Set for clinical parts: the professional whose care-relationship patients are exported. */
  professionalId?: string;
  /**
   * Rows a contributor reads per question when it returns a section as an async iterable
   * (`pagedRows`). Absent: `EXPORT_PAGE_SIZE`. A test lowers it to make the pages fall inside the data.
   */
  pageSize?: number;
}

/**
 * Produces one module's part of the export. It returns data; building PDFs is the exporter's job.
 *
 * A section of what it returns that can grow with the years of an organization (the audit trail, the
 * messages, the charges) is an async iterable made by `pagedRows`, which the exporter writes row by row
 * while the transaction of the context is open; a section that is bounded by the size of the
 * organization (its staff, its settings) may be an array.
 */
export type ExportContributor = (context: ExportContext) => Promise<unknown>;

export interface RegisteredContributor {
  kind: ExportKind;
  name: string;
  contribute: ExportContributor;
}

export interface ExportRegistry {
  registerExportContributor(kind: ExportKind, name: string, contribute: ExportContributor): void;
  list(kind?: ExportKind): RegisteredContributor[];
}

/**
 * The hook the cancellation export (Stage 6) is built on. Each module registers what it owns,
 * either `administrative` (goes to the owner) or `clinical` (goes to each professional for their
 * own patients). A test fails when a module directory registers nothing, so a new module cannot
 * be forgotten.
 */
export function createExportRegistry(): ExportRegistry {
  const entries: RegisteredContributor[] = [];

  return {
    registerExportContributor(kind, name, contribute) {
      if (entries.some((entry) => entry.kind === kind && entry.name === name)) {
        throw new Error(`Export contributor "${name}" (${kind}) is already registered`);
      }
      entries.push({ kind, name, contribute });
    },
    list(kind) {
      return entries.filter((entry) => kind === undefined || entry.kind === kind);
    },
  };
}
