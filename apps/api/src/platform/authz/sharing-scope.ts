/**
 * The sharing-scope predicate (design 4.2, authorization "One clinical visibility model"): may
 * this health professional READ this clinical entry? The caller has already passed `can()` and the
 * professional gate; this decides which entries of which patients that professional sees.
 *
 * The same rule is mirrored in the SQL function `app.clinical_readable` (migration 0011), as the
 * database backstop; an integration test checks that both agree on random inputs.
 */

/** What kind of clinical thing the entry is. Only notes carry a specialty template. */
export type ClinicalEntryKind = 'note' | 'anamnesis' | 'document' | 'consent' | 'prescription';

export interface ClinicalEntry {
  kind: ClinicalEntryKind;
  patientId: string;
  /** The professional who wrote it (the prescriber, for a prescription). */
  authorProfessionalId: string;
  /** `author_only` is set at creation or while a draft, and never changes after signing. */
  visibility: 'default' | 'author_only';
  /** The specialty template of a note (`general`, `psychology`, ...). Null for the other kinds. */
  templateKind: string | null;
}

export interface SharingSettings {
  /** The organization's switch for read-only sharing between its professionals. */
  clinicalSharing: boolean;
  /**
   * INCLUSION list of templates whose notes are shared. Only the templates listed are shared; a
   * template published later is not on it until the owner or admin adds it.
   */
  sharedTemplates: readonly string[];
}

export const PSYCHOLOGY_TEMPLATE = 'psychology';

/** The list when sharing is first enabled: today's templates without psychology. */
export const DEFAULT_SHARED_TEMPLATES: readonly string[] = [
  'general',
  'odontology',
  'physiotherapy',
  'nutrition',
];

/** Every published template except psychology: what turning sharing on starts with. */
export function initialSharedTemplates(published: readonly string[]): string[] {
  return published.filter((template) => template !== PSYCHOLOGY_TEMPLATE);
}

export type ReadBasis = 'author' | 'treating' | 'shared';
export type ReadVerdict = { readable: false } | { readable: true; basis: ReadBasis };

/** Whether the shared scope covers an entry. Prescriptions are never covered (D17). */
function sharedScopeIncludes(entry: ClinicalEntry, settings: SharingSettings): boolean {
  if (entry.kind === 'prescription') return false;
  if (entry.kind === 'note') {
    // A note without a template can never be on an inclusion list: not shared.
    return entry.templateKind !== null && settings.sharedTemplates.includes(entry.templateKind);
  }
  // Anamnesis, clinical documents and signed consent content follow the general ceiling.
  return true;
}

export interface ReadInput {
  entry: ClinicalEntry;
  /** The reader's professional id (from the professional gate). */
  professionalId: string;
  /** Whether the reader has an active care relationship with the entry's patient. */
  treating: boolean;
  settings: SharingSettings;
}

/**
 * Pure form of the rule, with the care relationship already known:
 *
 *   readable = author
 *     || (visibility is default && (treating
 *          || (not a prescription && sharing on && the shared scope covers the entry)))
 *
 * `author_only` overrides both the treating and the sharing paths. The basis says WHY the read is
 * allowed, so a shared read can be audited with its own marker.
 */
export function readableBasis(input: ReadInput): ReadVerdict {
  const { entry } = input;
  if (entry.authorProfessionalId === input.professionalId)
    return { readable: true, basis: 'author' };
  if (entry.visibility !== 'default') return { readable: false };
  if (input.treating) return { readable: true, basis: 'treating' };
  if (input.settings.clinicalSharing && sharedScopeIncludes(entry, input.settings)) {
    return { readable: true, basis: 'shared' };
  }
  return { readable: false };
}

/** The care relationship behind a port, so the rule does not know where it is stored. */
export interface SharingContext {
  settings: SharingSettings;
  isTreating(professionalId: string, patientId: string): Promise<boolean>;
}

/**
 * Same rule with the care relationship fetched through the port, only when it can matter: not for
 * the author, and not for an entry the author restricted. A port that fails is a refusal.
 */
export async function readable(
  entry: ClinicalEntry,
  professionalId: string,
  context: SharingContext,
): Promise<ReadVerdict> {
  if (entry.authorProfessionalId === professionalId) return { readable: true, basis: 'author' };
  if (entry.visibility !== 'default') return { readable: false };

  const treating = await context.isTreating(professionalId, entry.patientId).catch(() => null);
  if (treating === null) return { readable: false };
  return readableBasis({ entry, professionalId, treating, settings: context.settings });
}

/**
 * The `reason` an audit entry carries for a read: `shared` when the entry was read only because
 * of sharing (the reader neither wrote it nor treats the patient), nothing otherwise.
 */
export function sharedReadAuditReason(verdict: ReadVerdict): 'shared' | undefined {
  return verdict.readable && verdict.basis === 'shared' ? 'shared' : undefined;
}

/**
 * The `template_kind` argument that `app.clinical_readable` takes for an entry. The SQL function
 * sees a single text column: a template name for notes, NULL for the entries that follow the
 * general ceiling, and the marker `prescription` for prescriptions. A note with no template maps
 * to an empty name that is never on any list.
 */
export function sqlTemplateKind(entry: ClinicalEntry): string | null {
  if (entry.kind === 'prescription') return 'prescription';
  if (entry.kind === 'note') return entry.templateKind ?? '';
  return null;
}
