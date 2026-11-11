/**
 * Turns what a person typed in "Profesión o especialidad" into the list the API wants: one entry
 * per comma, trimmed, without empties and without repeats (compared ignoring case).
 */
export function splitSpecialties(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of text.split(',')) {
    const name = part.trim();
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}
