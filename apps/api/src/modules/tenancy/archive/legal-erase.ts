import type { ErasableObject } from '../../../adapters/archive-local/erasure.js';

/**
 * The procedure of the legal erasure of archived records (tenancy, "Retention archive after
 * cancellation": "a legally required erasure ... MAY be performed by a specifically privileged role
 * through a documented, audited procedure"). It is the fourth retention exception and the only way an
 * archived object is ever removed. It is deliberately a command (`pnpm archive:legal-erase`) that a
 * person runs with the credential of the `legal-erasure` identity, never a route or a job:
 *
 * - it needs the legal reference that orders it (an order, a file number), written to the platform
 *   trail with the counts of what was erased, never with a name or a record;
 * - it needs two NAMED people (JD-S6 R1-S6-7): the operator who runs it and a different one who
 *   approves it, each an active operator of the console. The trail carries the first as the actor and
 *   the second in its metadata;
 * - it is limited to the archive of ONE organization (the prefix must be inside it);
 * - it writes the INTENT in the platform trail before the first object goes (the trail is append-only,
 *   so an erasure that dies halfway cannot have left no trace), then the outcome, saying whether it
 *   is complete;
 * - it records in the database which folder was erased (`app.archive_mark_erased`) as soon as the
 *   first object is gone (not before: a credential that is refused erases nothing and marks nothing),
 *   so verification stops looking for what is meant to be gone and a release answers `erased`. A folder
 *   found EMPTY is marked only when the trail already holds an intent for it (a rerun of an erasure
 *   that was started), after a `rerun` entry; otherwise it is refused, because an empty listing can be
 *   a wrong bucket or the wrong scope of a credential (JD-S6 R3-1).
 *
 * What it does NOT do: the hot rows of the organization (its database) stay as they are, and so do the
 * backups of both; those are removed by their own retention (docs/runbooks/archive-release.md). The id
 * of an operator on the command line is an attribution checked against the console, not a login: the
 * control is the separate credential of the `legal-erasure` identity of the bucket, which only the
 * person who holds the order has.
 *
 * Erasing means every version of every object; an object that holds the records of several patients
 * (a piece of a package) goes whole. Taking one patient out of an encrypted piece is not something an
 * immutable archive can do, and the order that requires it is for counsel to read.
 */

export interface LegalEraseAuditEntry {
  /**
   * `intent` before the first object goes, then `done`, or `incomplete` when it stopped halfway.
   * `rerun` when the folder was found empty after an intent: nothing left to erase, only the marker.
   */
  phase: 'intent' | 'done' | 'incomplete' | 'rerun';
  reason: string;
  /** The operator who runs the command. */
  operatorId: string;
  /** The different operator who approved it. */
  approverId: string;
  prefix: string;
  /** For `intent`, how many objects it is about to erase; otherwise how many it erased. */
  objects: number;
  versions: number;
}

export interface LegalEraseDeps {
  eraser: {
    list(prefix: string): Promise<ErasableObject[]>;
    erase(
      key: string,
      input: { reference: string },
    ): Promise<{ status: 'erased'; versions: number } | { status: 'unknown' }>;
  };
  /** Throws unless every id is an active operator of the console. */
  verifyOperators(ids: readonly string[]): Promise<void>;
  /**
   * Whether the platform trail already holds an `intent` of an erasure that covers this folder (the same
   * folder or one that contains it): proof that an erasure was started, and not an empty listing for
   * some other reason (JD-S6 R3-1).
   */
  hasIntent(prefix: string): Promise<boolean>;
  /** Records in the database that the folder of the archive is erased (once the first object is gone). */
  markErased(prefix: string): Promise<void>;
  /** Writes the entry of the platform trail (`archive.erased`). Append-only. */
  audit(entry: LegalEraseAuditEntry): Promise<void>;
}

export interface LegalEraseInput {
  tenantId: string;
  reference: string;
  /** The operator who runs the command. */
  operatorId: string;
  /** A different operator who approves it. */
  approverId: string;
  /** Narrows the erasure to a folder of the archive of the organization. */
  prefix?: string;
}

const MIN_REFERENCE = 5;
const MAX_REFERENCE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function legalErase(
  deps: LegalEraseDeps,
  input: LegalEraseInput,
): Promise<{ objects: number; versions: number }> {
  const reference = input.reference.trim();
  if (reference.length < MIN_REFERENCE || reference.length > MAX_REFERENCE) {
    throw new Error(
      `The legal erasure needs the legal reference that orders it (${String(MIN_REFERENCE)} to ${String(MAX_REFERENCE)} characters)`,
    );
  }
  if (!UUID.test(input.operatorId) || !UUID.test(input.approverId)) {
    throw new Error(
      'The legal erasure needs the operator who runs it and the operator who approves it',
    );
  }
  if (input.operatorId.toLowerCase() === input.approverId.toLowerCase()) {
    throw new Error('The operator who approves the legal erasure is not the one who runs it');
  }
  const root = `tenants/${input.tenantId}/`;
  const prefix = input.prefix ?? root;
  if (!prefix.startsWith(root)) {
    throw new Error('The prefix to erase must be inside the archive of the organization');
  }
  // A folder ends in a slash: `tenants/<id>/clinical` would also match `clinical-2` (JD-S6 R2).
  if (!prefix.endsWith('/')) {
    throw new Error('The prefix to erase is a folder and must end with a slash');
  }
  await deps.verifyOperators([input.operatorId, input.approverId]);

  const entry = (
    phase: LegalEraseAuditEntry['phase'],
    objects: number,
    versions: number,
  ): LegalEraseAuditEntry => ({
    phase,
    reason: reference,
    operatorId: input.operatorId,
    approverId: input.approverId,
    prefix,
    objects,
    versions,
  });

  const found = await deps.eraser.list(prefix);
  if (found.length === 0) {
    // An empty listing is the proof of an erasure only when one was started: a rerun of an erasure that
    // went through the objects but died before the marker. For any other reason (a wrong bucket, a
    // listing credential with the wrong scope, a listing that lags) marking the folder erased would
    // delete the plaintext export of an archive that is intact (JD-S6 R3-1), so nothing is marked.
    if (!(await deps.hasIntent(prefix))) {
      throw new Error(
        `Nothing was found under ${prefix} and no erasure of it was ever started. Confirm the bucket (ARCHIVE_S3_BUCKET, ARCHIVE_S3_ENDPOINT) and the scope of the credential; nothing was marked.`,
      );
    }
    // The trail says it before the database does: a mark with no trace is not allowed.
    await deps.audit(entry('rerun', 0, 0));
    await deps.markErased(prefix);
    return { objects: 0, versions: 0 };
  }

  // The intent first: if anything below dies, the trail already says who ordered what and why.
  await deps.audit(entry('intent', found.length, 0));

  let objects = 0;
  let versions = 0;
  try {
    for (const object of found) {
      const erased = await deps.eraser.erase(object.key, { reference });
      if (erased.status === 'erased') {
        objects += 1;
        versions += erased.versions;
        // From the first object on, the archive is (partly) gone: say so before anything looks for it.
        if (objects === 1) await deps.markErased(prefix);
      }
    }
  } catch (error) {
    await deps.audit(entry('incomplete', objects, versions));
    throw error;
  }
  await deps.audit(entry('done', objects, versions));
  return { objects, versions };
}

export interface LegalEraseArguments {
  reference: string;
  tenantId: string;
  operatorId: string;
  approverId: string;
  prefix?: string;
  /** Without it the command only says what it would erase. */
  confirmed: boolean;
}

/** Reads `--reference <text> --tenant <uuid> --operator <uuid> --approver <uuid> [--prefix <p>] [--yes]`. */
export function parseLegalEraseArguments(argv: readonly string[]): LegalEraseArguments {
  let reference: string | undefined;
  let tenantId: string | undefined;
  let operatorId: string | undefined;
  let approverId: string | undefined;
  let prefix: string | undefined;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--yes') {
      confirmed = true;
    } else if (
      flag === '--reference' ||
      flag === '--tenant' ||
      flag === '--prefix' ||
      flag === '--operator' ||
      flag === '--approver'
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      index += 1;
      if (flag === '--reference') reference = value;
      else if (flag === '--tenant') tenantId = value;
      else if (flag === '--operator') operatorId = value;
      else if (flag === '--approver') approverId = value;
      else prefix = value;
    } else {
      throw new Error(`Unknown argument ${flag ?? ''}`);
    }
  }
  if (reference === undefined)
    throw new Error('--reference <text> is required: the legal basis of the erasure');
  if (tenantId === undefined || !UUID.test(tenantId)) {
    throw new Error('--tenant <uuid> is required: the organization whose archive is erased');
  }
  if (operatorId === undefined || !UUID.test(operatorId)) {
    throw new Error('--operator <uuid> is required: the operator who runs the erasure');
  }
  if (approverId === undefined || !UUID.test(approverId)) {
    throw new Error('--approver <uuid> is required: a different operator who approves the erasure');
  }
  if (operatorId.toLowerCase() === approverId.toLowerCase()) {
    throw new Error('--approver must be a different operator than --operator');
  }
  return {
    reference,
    tenantId,
    operatorId,
    approverId,
    ...(prefix === undefined ? {} : { prefix }),
    confirmed,
  };
}
