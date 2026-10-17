import type { NoteStatus, ReadBasisName } from './types.js';

/**
 * What a reader may do with a clinical entry (clinical-records; authorization, "Addendum" and
 * "Mark entered in error"). The database enforces the same rules with policies and triggers; this
 * is the pure form the services and the screens share, so a button is shown only for an action
 * that will work.
 */
export interface AccessInput {
  status: NoteStatus;
  /** The reader wrote the entry. */
  isAuthor: boolean;
  /** The reader has an active care relationship with the patient. */
  treating: boolean;
  /** False while the organization is read-only (D16). */
  tenantActive: boolean;
}

export interface NoteAccess {
  basis: ReadBasisName;
  canEdit: boolean;
  canSign: boolean;
  canAddAddendum: boolean;
  canMarkError: boolean;
  /** In a read-only organization only a rectification addendum is allowed. */
  rectificationOnly: boolean;
}

export function noteAccess(input: AccessInput): NoteAccess {
  const { status, isAuthor, treating, tenantActive } = input;
  const ownDraft = status === 'draft' && isAuthor && tenantActive;
  return {
    basis: isAuthor ? 'author' : treating ? 'treating' : 'shared',
    canEdit: ownDraft,
    canSign: ownDraft,
    // Shared access is read-only: an addendum needs a care relationship.
    canAddAddendum: status === 'signed' && treating,
    canMarkError:
      tenantActive &&
      ((status === 'draft' && isAuthor) || (status === 'signed' && (isAuthor || treating))),
    rectificationOnly: !tenantActive,
  };
}

const HEADLINE_KEYS = [
  'reasonForConsultation',
  'topics',
  'affectedRegion',
  'observations',
  'diagnosis',
  'goals',
  'symptoms',
  'plan',
] as const;

const HEADLINE_LENGTH = 160;

/** The first line of what an entry says, for lists: the reason for consultation, the topics... */
export function headlineOf(content: Record<string, unknown>): string | null {
  for (const key of HEADLINE_KEYS) {
    const value = content[key];
    if (typeof value !== 'string') continue;
    const line = value.trim().split('\n')[0]?.trim() ?? '';
    if (line === '') continue;
    return line.length > HEADLINE_LENGTH ? `${line.slice(0, HEADLINE_LENGTH - 1)}…` : line;
  }
  return null;
}
