import { describe, expect, it } from 'vitest';

import { INN_SAMPLE, searchGenericNames, startsWithGenericName } from './inn-sample.js';

describe('the sample catalog of generic names', () => {
  it('has no repeated name', () => {
    expect(new Set(INN_SAMPLE).size).toBe(INN_SAMPLE.length);
  });

  it('suggests the names that start with what is typed, whatever the case or the accents', () => {
    expect(searchGenericNames('losar', 10)).toEqual(['Losartán']);
    expect(searchGenericNames('LOSARTAN', 10)).toEqual(['Losartán']);
    expect(searchGenericNames('amox', 10)).toEqual([
      'Amoxicilina',
      'Amoxicilina con ácido clavulánico',
    ]);
  });

  it('suggests a name by a later word too, so "clavulánico" finds the combination', () => {
    expect(searchGenericNames('clavul', 10)).toEqual(['Amoxicilina con ácido clavulánico']);
  });

  it('lists the first names when nothing is typed, up to the limit, and nothing for a name it does not know', () => {
    expect(searchGenericNames('', 3)).toHaveLength(3);
    expect(searchGenericNames('zzzz', 10)).toEqual([]);
  });

  it('recognises a prescription line that starts with a name of the catalog', () => {
    expect(
      startsWithGenericName('Amoxicilina 500 mg, comprimidos, cantidad 21. 1 cada 8 horas'),
    ).toBe(true);
    expect(startsWithGenericName('amoxicilina con acido clavulanico 875 mg, cantidad 14')).toBe(
      true,
    );
    expect(startsWithGenericName('Losartan')).toBe(true);
  });

  it('does not recognise a brand, a made-up name or a name that only shares a prefix', () => {
    expect(startsWithGenericName('Amoxidal 500 mg, comprimidos')).toBe(false);
    expect(startsWithGenericName('Zzzcilina 10 mg')).toBe(false);
    expect(startsWithGenericName('Amoxicilinas 500 mg')).toBe(false);
  });
});
