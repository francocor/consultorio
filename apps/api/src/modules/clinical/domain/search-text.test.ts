import { describe, expect, it } from 'vitest';

import { findMatch, foldText, textsOf } from './search-text.js';

describe('foldText', () => {
  it('removes accents and lower-cases, mapping every folded character to its original position', () => {
    const folded = foldText('HipertensiÓn Arterial');

    expect(folded.text).toBe('hipertension arterial');
    expect(folded.origins).toHaveLength(folded.text.length);
    expect(folded.origins[0]).toBe(0);
    expect(folded.origins[11]).toBe(11);
  });

  it('copes with text that decomposes into several characters', () => {
    const folded = foldText('ﬁn Ñandú');

    expect(folded.text).toBe('fin nandu');
  });
});

describe('findMatch', () => {
  it('finds a term without regard to accents or case', () => {
    expect(findMatch('Paciente con HIPERTENSIÓN arterial leve', 'hipertension')).toMatchObject({
      start: 13,
    });
    expect(findMatch('Antecedente de hipertensión', 'HIPERTENSIÓN')).not.toBeNull();
    expect(findMatch('Tos seca', 'hipertension')).toBeNull();
  });

  it('returns a snippet of the original words around the match, with ellipses when cut', () => {
    const text = `${'x'.repeat(100)} dolor torácico opresivo ${'y'.repeat(100)}`;

    const match = findMatch(text, 'toracico');

    expect(match?.snippet).toContain('dolor torácico opresivo');
    expect(match?.snippet.startsWith('…')).toBe(true);
    expect(match?.snippet.endsWith('…')).toBe(true);
    expect((match?.snippet.length ?? 0) < 120).toBe(true);
  });

  it('does not add ellipses to a short text', () => {
    expect(findMatch('Tos seca', 'seca')?.snippet).toBe('Tos seca');
  });

  it('ignores a query with nothing but spaces', () => {
    expect(findMatch('Tos seca', '   ')).toBeNull();
  });
});

describe('textsOf', () => {
  it('collects every string of a content object, including nested ones, in a stable order', () => {
    const texts = textsOf({
      reasonForConsultation: 'Control',
      measurements: [{ name: 'Peso', value: '72', unit: 'kg' }],
      odontogram: { '16': { condition: 'caries', note: 'sensible al frío' } },
      painIntensity: 6,
      confirmed: true,
    });

    expect(texts).toEqual(['Control', 'Peso', '72', 'kg', 'caries', 'sensible al frío']);
  });

  it('returns nothing for content with no text', () => {
    expect(textsOf({ painIntensity: 3, done: false })).toEqual([]);
  });
});
