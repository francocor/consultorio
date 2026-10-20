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
 * - it is limited to the archive of ONE organization (the prefix must be inside it);
 * - it writes its entry even when it stops halfway, saying that it is incomplete.
 *
 * Erasing means every version of every object; an object that holds the records of several patients
 * (a piece of a package) goes whole. Taking one patient out of an encrypted piece is not something an
 * immutable archive can do, and the order that requires it is for counsel to read.
 */

export interface LegalEraseDeps {
  eraser: {
    list(prefix: string): Promise<ErasableObject[]>;
    erase(
      key: string,
      input: { reference: string },
    ): Promise<{ status: 'erased'; versions: number } | { status: 'unknown' }>;
  };
  /** Writes the entry of the platform trail (`archive.erased`). */
  audit(entry: {
    reason: string;
    objects: number;
    versions: number;
    complete: boolean;
  }): Promise<void>;
}

export interface LegalEraseInput {
  tenantId: string;
  reference: string;
  /** Narrows the erasure to a folder of the archive of the organization. */
  prefix?: string;
}

const MIN_REFERENCE = 5;
const MAX_REFERENCE = 500;

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
  const root = `tenants/${input.tenantId}/`;
  const prefix = input.prefix ?? root;
  if (!prefix.startsWith(root)) {
    throw new Error('The prefix to erase must be inside the archive of the organization');
  }

  const found = await deps.eraser.list(prefix);
  let objects = 0;
  let versions = 0;
  try {
    for (const object of found) {
      const erased = await deps.eraser.erase(object.key, { reference });
      if (erased.status === 'erased') {
        objects += 1;
        versions += erased.versions;
      }
    }
  } catch (error) {
    if (objects > 0) await deps.audit({ reason: reference, objects, versions, complete: false });
    throw error;
  }
  if (objects > 0) await deps.audit({ reason: reference, objects, versions, complete: true });
  return { objects, versions };
}

export interface LegalEraseArguments {
  reference: string;
  tenantId: string;
  prefix?: string;
  /** Without it the command only says what it would erase. */
  confirmed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads `--reference <text> --tenant <uuid> [--prefix <p>] [--yes]`. */
export function parseLegalEraseArguments(argv: readonly string[]): LegalEraseArguments {
  let reference: string | undefined;
  let tenantId: string | undefined;
  let prefix: string | undefined;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--yes') {
      confirmed = true;
    } else if (flag === '--reference' || flag === '--tenant' || flag === '--prefix') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      index += 1;
      if (flag === '--reference') reference = value;
      else if (flag === '--tenant') tenantId = value;
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
  return { reference, tenantId, ...(prefix === undefined ? {} : { prefix }), confirmed };
}
