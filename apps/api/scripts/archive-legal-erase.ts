import { createLegalErasure } from '../src/adapters/archive-local/erasure.js';
import { loadConfig } from '../src/main/config.js';
import { createLegalEraseDatabase } from '../src/modules/tenancy/archive/legal-erase-database.js';
import {
  legalErase,
  parseLegalEraseArguments,
} from '../src/modules/tenancy/archive/legal-erase.js';
import { createOperatorDb } from '../src/platform/db/pool.js';
import { createWithTenant } from '../src/platform/db/tenant-context.js';

/**
 * The legal erasure of an organization's archive (tenancy, "Retention archive after cancellation"). The
 * ONLY way an archived object is ever removed, and it is meant to be run by a person who holds a legal
 * order, with the credential of the `legal-erasure` identity of the archive bucket:
 *
 *   ARCHIVE_LEGAL_ERASURE_ACCESS_KEY_ID=legal-erasure \
 *   ARCHIVE_LEGAL_ERASURE_SECRET_ACCESS_KEY='...' \
 *     pnpm archive:legal-erase --tenant <uuid> --reference "Oficio 123/2031, Juzgado ..." \
 *       --operator <operator id> --approver <a different operator id> [--prefix <p>] [--yes]
 *
 * Two named people (JD-S6 R1-S6-7): the operator who runs it and a different one who approves it, both
 * active operators of the console (their ids are in the operators list of the console). Without `--yes`
 * it only lists what it would erase. The legal reference goes to the platform trail (`archive.erased`):
 * first the INTENT, before the first object goes, then the outcome with the counts, with the operator
 * as the actor and the approver in the metadata. The folder erased is recorded in the database so
 * verification skips it and a release answers `erased`. The hot rows of the organization and the
 * backups are NOT touched (docs/runbooks/archive-release.md). It reads the bucket and the database like the application does
 * (`ARCHIVE_S3_BUCKET`, `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_REGION`, `OPERATOR_DATABASE_URL`), but the
 * credential is its own: the writer of the application cannot erase.
 */
async function main(): Promise<void> {
  let input;
  try {
    input = parseLegalEraseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments'}\n`);
    process.exit(2);
  }

  const env = process.env;
  const bucket = env['ARCHIVE_S3_BUCKET'];
  const endpoint = env['ARCHIVE_S3_ENDPOINT'];
  const accessKeyId = env['ARCHIVE_LEGAL_ERASURE_ACCESS_KEY_ID'];
  const secretAccessKey = env['ARCHIVE_LEGAL_ERASURE_SECRET_ACCESS_KEY'];
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    process.stderr.write(
      'Set ARCHIVE_S3_BUCKET, ARCHIVE_S3_ENDPOINT, ARCHIVE_LEGAL_ERASURE_ACCESS_KEY_ID and ARCHIVE_LEGAL_ERASURE_SECRET_ACCESS_KEY.\n',
    );
    process.exit(2);
  }
  const config = loadConfig();
  if (!config.operatorDatabaseUrl) {
    process.stderr.write(
      'OPERATOR_DATABASE_URL is not set: the erasure is written to the platform trail.\n',
    );
    process.exit(2);
  }

  const eraser = createLegalErasure({
    bucket,
    endpoint,
    region: env['ARCHIVE_S3_REGION'] ?? 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
  });
  const operatorDb = createOperatorDb(config.operatorDatabaseUrl);
  try {
    if (!input.confirmed) {
      const prefix = input.prefix ?? `tenants/${input.tenantId}/`;
      const found = await eraser.list(prefix);
      process.stdout.write(
        `${String(found.length)} objects under ${prefix} would be erased. Run again with --yes to erase them.\n`,
      );
      return;
    }
    const withTenant = createWithTenant(operatorDb.db);
    const result = await legalErase(
      {
        eraser,
        ...createLegalEraseDatabase({
          withTenant,
          tenantId: input.tenantId,
          operatorId: input.operatorId,
        }),
      },
      {
        tenantId: input.tenantId,
        reference: input.reference,
        operatorId: input.operatorId,
        approverId: input.approverId,
        ...(input.prefix ? { prefix: input.prefix } : {}),
      },
    );
    process.stdout.write(
      `Erased ${String(result.objects)} objects (${String(result.versions)} versions). The legal reference is in the platform trail.\n`,
    );
  } finally {
    eraser.close();
    await operatorDb.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'The erasure failed'}\n`);
  process.exit(1);
});
