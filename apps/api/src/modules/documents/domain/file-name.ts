/**
 * File names (documents, "Type and size validation": file names MUST be sanitized and MUST NOT
 * influence the storage location). The name a user's computer reports is only ever text to show
 * back. Files are stored under a key made of the document id, never of the name.
 */

const FALLBACK = 'archivo';
const MAX_LENGTH = 200;
const MAX_EXTENSION = 12;

/**
 * Code point ranges that are removed from a name: control characters (C0 and C1), the soft hyphen,
 * zero-width and invisible formatting characters, and the bidirectional overrides (U+202A to
 * U+202E and U+2066 to U+2069) that make a name such as "informe" + U+202E + "fdp.exe" show as
 * "informe.exe.pdf". Written as numbers so the source holds no invisible character itself.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isInvisible(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return INVISIBLE_RANGES.some(([low, high]) => code >= low && code <= high);
}

function removeInvisible(text: string): string {
  return Array.from(text)
    .filter((character) => !isInvisible(character))
    .join('');
}

function fitLength(name: string): string {
  if (name.length <= MAX_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= MAX_EXTENSION ? name.slice(dot) : '';
  return `${name.slice(0, MAX_LENGTH - extension.length)}${extension}`;
}

/**
 * Cleans a name for display: no directories (both separators), no control or invisible
 * characters, no leading dots (a hidden file) or trailing dots and spaces, at most 200
 * characters with the extension kept. Never empty.
 */
export function sanitizeFileName(input: string): string {
  const withoutInvisible = removeInvisible(input.normalize('NFC'));
  const lastSegment = withoutInvisible.split(/[/\\]/).pop() ?? '';
  const trimmed = lastSegment
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (trimmed === '') return FALLBACK;
  return fitLength(trimmed);
}

/**
 * The `Content-Disposition` of a download: always an attachment, with an ASCII-only `filename`
 * for old clients and the real name in `filename*` (RFC 6266 and 5987). Neither part can carry a
 * quote, a line break or a separator, so a name cannot add a header or change the disposition.
 */
export function contentDisposition(name: string): string {
  const clean = sanitizeFileName(name);
  const ascii = Array.from(clean, (character) =>
    /[A-Za-z0-9._-]/.test(character) ? character : '_',
  ).join('');
  const encoded = encodeURIComponent(clean).replace(
    /['()*!]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
