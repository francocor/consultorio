import { AccessRefused } from '../../access/index.js';

/** The entry a refusal is about, so the deny entry of the audit log can name the patient. */
export interface RefusedEntry {
  patientId: string;
  noteId: string;
}

/**
 * The entry is not in the state the request needs (a signed entry cannot be edited, an entry
 * marked in error cannot be signed). The route answers 409 and writes a deny entry to the audit
 * log on its own connection, because an attempt to change an immutable entry must leave a trace
 * (clinical-records, "Edit attempt on a signed entry"). The reason is for the audit trail only.
 */
export class NoteConflict extends Error {
  constructor(
    readonly reason: string,
    readonly entry: RefusedEntry,
  ) {
    super(reason);
    this.name = 'NoteConflict';
  }
}

/** A refusal (403) that knows which entry and patient it is about. */
export class NoteDenied extends AccessRefused {
  constructor(
    reason: string,
    readonly entry: RefusedEntry,
  ) {
    super(reason);
    this.name = 'NoteDenied';
  }
}

export function refusedEntry(note: { id: string; patientId: string }): RefusedEntry {
  return { patientId: note.patientId, noteId: note.id };
}
