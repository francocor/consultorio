import { createHash } from 'node:crypto';

/**
 * The canonical text of a JSON value: object keys sorted at every level, arrays in order, members
 * that are `undefined` left out. Two contents that mean the same thing give the same text, so the
 * hash of a signed note does not depend on the order a form happened to send its fields.
 */
export function canonicalJson(value: unknown): string {
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

/**
 * SHA-256 (hex) of the canonical text. It is stored beside the signed content, so anyone who can
 * read the entry can check that it is the one that was signed (clinical-records, "Version history").
 */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
