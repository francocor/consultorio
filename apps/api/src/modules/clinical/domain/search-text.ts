/**
 * Text matching for the per-patient clinical search (design 4.3). Plaintext is only ever held in
 * memory for one request: the entries are decrypted, folded here and compared, and nothing is
 * indexed or kept.
 */

export interface Folded {
  /** The text without accents and in lower case. */
  text: string;
  /** For every character of `text`, the position of the character it came from in the original. */
  origins: number[];
}

const DIACRITICS = /\p{Diacritic}/gu;

/**
 * Folds text for a comparison that ignores accents and case. Each original character is folded on
 * its own, so the result can be mapped back to the original words (for the snippet).
 */
export function foldText(original: string): Folded {
  let text = '';
  const origins: number[] = [];
  let index = 0;
  for (const character of original) {
    const part = character.normalize('NFKD').replace(DIACRITICS, '').toLowerCase();
    for (const folded of part) {
      text += folded;
      origins.push(index);
    }
    index += character.length;
  }
  return { text, origins };
}

const SNIPPET_RADIUS = 40;

export interface Match {
  /** Where the match starts in the original text. */
  start: number;
  /** A piece of the original text around the match, with ellipses where it was cut. */
  snippet: string;
}

/** Finds the first occurrence of a term, ignoring accents and case. Null when there is none. */
export function findMatch(original: string, term: string): Match | null {
  const wanted = foldText(term.trim()).text;
  if (wanted === '') return null;
  const folded = foldText(original);
  const at = folded.text.indexOf(wanted);
  if (at === -1) return null;

  const start = folded.origins[at] ?? 0;
  const last = folded.origins[at + wanted.length - 1] ?? start;
  const from = Math.max(0, start - SNIPPET_RADIUS);
  const to = Math.min(original.length, last + 1 + SNIPPET_RADIUS);
  const piece = original.slice(from, to).trim();
  return {
    start,
    snippet: `${from > 0 ? '…' : ''}${piece}${to < original.length ? '…' : ''}`,
  };
}

/** Every string inside a content object, nested ones included, in the order they appear. */
export function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) return content.flatMap(textsOf);
  if (typeof content === 'object' && content !== null) {
    return Object.values(content).flatMap(textsOf);
  }
  return [];
}
