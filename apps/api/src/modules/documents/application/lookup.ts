import { sql } from 'drizzle-orm';

import type { DocumentRow } from '../../../db/schema/documents.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { findDocument } from './read-model.js';
import { DocumentRefused } from './refusal.js';

/**
 * Finds the document an action is about, with the answer a denial must give.
 *
 * Row level security hides a clinical document from whoever may not read it, so "I cannot see it"
 * can mean "it does not exist", "it is in another organization" or "it is clinical and not yours".
 * The first two are a plain not found. The third is a refusal, audited, because a request for a
 * clinical document by reception or the administration is exactly what the trail must show
 * (documents, "Admin tries to download a clinical document"). The database tells them apart with
 * `app.document_probe`, which answers only whether a document with that id exists in THIS
 * organization and what class it has, and nothing else.
 */
export async function loadForAction(tx: Tx, documentId: string): Promise<DocumentRow> {
  const row = await findDocument(tx, documentId);
  if (row) {
    // An upload nobody confirmed (or an abandoned one) is not a document yet.
    if (row.uploadCompletedAt === null || row.abandonedAt !== null) throw new AppError('not_found');
    return row;
  }
  const probe = await tx.execute<{ classification: string | null }>(
    sql`select app.document_probe(${documentId}::uuid) as classification`,
  );
  if (probe.rows[0]?.classification === 'clinical') {
    throw new DocumentRefused('document_not_readable', { resourceId: documentId });
  }
  throw new AppError('not_found');
}
