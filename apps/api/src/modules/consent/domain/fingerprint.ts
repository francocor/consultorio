import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The fingerprints of informed consent (informed-consent, "Signature capture and binding"): a
 * SHA-256 over a canonical text, so anyone who can read a signed consent can check it is the one
 * that was signed. Pure: nothing here reads the database or the clock.
 *
 * Two fingerprints exist, and they are different things:
 * - the fingerprint of a template VERSION (`templateFingerprint`), made when the version is
 *   published and shared by publishing and signing: it proves WHAT text the signer was shown;
 * - the fingerprint of a SIGNATURE (`signatureFingerprint`), made when somebody signs: it covers
 *   the version fingerprint plus who signed, how and when, so it proves the whole signed record.
 */

/**
 * The text as it is read, with the whitespace that is not read taken out. This is the one place
 * that defines which inputs count as the same text:
 *
 * - Unicode normalization form C (an accent typed as two characters is the same as one);
 * - every line break (CRLF, CR, LF) is a line feed;
 * - the spaces and tabs at the END of a line go (they are not visible);
 * - blank lines at the start and the end go.
 *
 * What stays: the spaces inside a line, the order of the lines and a blank line between two
 * paragraphs, because they change what the patient reads.
 */
export function canonicalText(text: string): string {
  const lines = text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+$/u, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** A title is one line: runs of whitespace are one space and the ends are trimmed. */
function canonicalTitle(title: string): string {
  return title.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** JSON with the keys of every object sorted, so the order a record was built in never matters. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The fingerprint of a template version: SHA-256 (hex) of the canonical JSON of its title and body.
 * The title and the body are separate members of the JSON, so a word moved from one to the other
 * is a different content.
 */
export function templateFingerprint(content: { title: string; body: string }): string {
  return sha256(
    canonicalJson({ title: canonicalTitle(content.title), body: canonicalText(content.body) }),
  );
}

/** What the signer left as their mark: a typed name, or a drawing (its digest is what is kept). */
export interface SignatureMark {
  kind: 'typed' | 'drawn';
  /** The typed name, or the SHA-256 (hex) of the drawn image. */
  value: string;
}

/** The data of a legal representative who signs for the patient (a minor, or who cannot consent). */
export interface RepresentativeFacts {
  name: string;
  nationalId: string;
  relation: string;
}

/** Everything the fingerprint of a signature covers. */
export interface SignedFacts {
  requestId: string;
  patientId: string;
  /** The version the signer was shown (never the latest one by the time they submit). */
  versionId: string;
  versionFingerprint: string;
  signerKind: 'patient' | 'representative';
  representative: RepresentativeFacts | null;
  accepted: boolean;
  method: 'in_person' | 'portal';
  /** ISO 8601 with milliseconds, in UTC. */
  signedAt: string;
  mark: SignatureMark;
  /**
   * The version of the facts the fingerprint was made from. Version 1 (no version given, the records
   * signed before) does not cover the name the signer typed; version 2 does (JD-S5 R2, A-W3). A
   * record is verified against the version it was signed with, so the old ones still verify.
   */
  version?: 1 | 2;
  /** The full name the signer typed, covered from version 2 on. Null when the record has none. */
  signerName?: string | null;
}

/** SHA-256 (hex) of the canonical JSON of the facts of a signature. */
export function signatureFingerprint(facts: SignedFacts): string {
  const second =
    facts.version === 2
      ? {
          v: 2,
          signerName: facts.signerName == null ? null : canonicalTitle(facts.signerName),
        }
      : {};
  return sha256(
    canonicalJson({
      ...second,
      requestId: facts.requestId,
      patientId: facts.patientId,
      versionId: facts.versionId,
      versionFingerprint: facts.versionFingerprint,
      signerKind: facts.signerKind,
      representative:
        facts.representative === null
          ? null
          : {
              name: canonicalTitle(facts.representative.name),
              nationalId: facts.representative.nationalId.trim(),
              relation: canonicalTitle(facts.representative.relation),
            },
      accepted: facts.accepted,
      method: facts.method,
      signedAt: facts.signedAt,
      mark: { kind: facts.mark.kind, value: facts.mark.value },
    }),
  );
}

/** Does the stored fingerprint still match the facts it was made from? */
export function verifySignatureFingerprint(facts: SignedFacts, stored: string): boolean {
  const expected = Buffer.from(signatureFingerprint(facts), 'utf8');
  const actual = Buffer.from(stored, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
