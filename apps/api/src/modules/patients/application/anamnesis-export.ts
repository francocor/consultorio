import { AnamnesisContent } from '@consultorio/contracts';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { anamnesis } from '../../../db/schema/anamnesis.js';
import { careRelationship } from '../../../db/schema/care.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { pagedRows, type ExportContributor } from '../../tenancy/index.js';

const FIELD = { table: 'anamnesis', column: 'content_enc' } as const;

/** Where a version is in the order of the export: its patient and then its number. */
interface VersionCursor {
  patientId: string;
  version: number;
}

/**
 * The anamnesis part of the cancellation export (patients, "Anamnesis is clinical data"; tenancy,
 * "Tenant cancellation export": the clinical export carries the anamnesis). It is clinical and per
 * professional, like the entries: every saved version of the anamnesis of the patients a
 * professional wrote for or treats, decrypted with the key of the organization. The context carries
 * a transaction that acts as that professional, so the clinical policies of the database decide what
 * is readable and the sharing scope never widens an export. Every version stays: an anamnesis is
 * never overwritten, and the history is part of the record. The versions are read a page at a time and
 * decrypted as the exporter writes them.
 *
 * Like the other clinical parts, it fails instead of delivering an empty record that would look
 * complete when it lacks the key service or the professional.
 */
export function exportAnamnesis(keys?: TenantKeys): ExportContributor {
  return ({ tx, professionalId, pageSize }) => {
    if (!keys) return Promise.reject(new Error('The anamnesis export needs the key service'));
    if (!professionalId) {
      return Promise.reject(new Error('The anamnesis export is made for one professional'));
    }

    // Narrowed here, for the generator below (a closure does not keep the narrowing of a parameter).
    const key: TenantKeys = keys;
    const professional: string = professionalId;
    const treated = tx
      .select({ patientId: careRelationship.patientId })
      .from(careRelationship)
      .where(
        and(eq(careRelationship.professionalId, professional), eq(careRelationship.active, true)),
      );

    async function* versions() {
      for await (const row of pagedRows<typeof anamnesis.$inferSelect, VersionCursor>({
        pageSize,
        fetch: (after, limit) =>
          tx
            .select()
            .from(anamnesis)
            .where(
              and(
                or(
                  eq(anamnesis.authorProfessionalId, professional),
                  inArray(anamnesis.patientId, treated),
                ),
                after === null
                  ? undefined
                  : sql`(${anamnesis.patientId}, ${anamnesis.version}) > (${after.patientId}::uuid, ${after.version}::int)`,
              ),
            )
            .orderBy(asc(anamnesis.patientId), asc(anamnesis.version))
            .limit(limit),
        cursorOf: (row) => ({ patientId: row.patientId, version: row.version }),
      })) {
        const plain = await key.decryptField(tx, { ...FIELD, rowId: row.id }, row.contentEnc);
        yield {
          patientId: row.patientId,
          version: row.version,
          savedAt: row.createdAt,
          authorProfessionalId: row.authorProfessionalId,
          content: AnamnesisContent.parse(JSON.parse(plain.toString('utf8'))),
        };
      }
    }

    return Promise.resolve({ anamnesis: versions() });
  };
}
