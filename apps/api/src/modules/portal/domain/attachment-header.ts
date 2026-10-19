/**
 * The `Content-Disposition` header of a file the portal hands to a patient. The name comes from
 * outside (what somebody called an upload, a title) and must never reach a header as it is: a line
 * break would split the header, a quote would end the name early. The header says `attachment`, so a
 * browser saves the file instead of opening it in the page of the portal.
 *
 * It carries two names: an ASCII one for old clients and the real one as `filename*` (RFC 6266 and
 * 8187), percent-encoded, so an accent survives.
 */
const FALLBACK = 'archivo';

/** Control characters (C0 and DEL) have no place in a header value or in a file name. */
function withoutControl(text: string): string {
  return Array.from(text)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('');
}

export function attachmentHeader(name: string): string {
  const ascii =
    withoutControl(name)
      .normalize('NFKD')
      // The combining marks that NFKD splits off an accented letter, then anything that is not
      // printable ASCII, then the characters that would end or escape the quoted name.
      .replaceAll(/\p{M}/gu, '')
      .replaceAll(/[^\x20-\x7e]/g, '')
      .replaceAll(/["\\/;]/g, '_')
      .trim() || FALLBACK;
  const encoded = encodeURIComponent(withoutControl(name)).replaceAll(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
