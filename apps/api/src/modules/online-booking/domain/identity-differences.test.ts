import { describe, expect, it } from 'vitest';

import { identityDifferences } from './identity-differences.js';

const onFile = {
  givenNames: 'Lucía',
  familyName: 'Fernández',
  birthDate: '1990-04-02',
  phone: '+54 11 4444 1111',
  email: 'lucia@example.test',
};

describe('identityDifferences', () => {
  it('lists nothing when the form says what the record says', () => {
    expect(identityDifferences(onFile, { ...onFile })).toEqual([]);
  });

  it('lists the phone that differs, with what was submitted and what is on file', () => {
    expect(identityDifferences(onFile, { ...onFile, phone: '+54 11 5555 0000' })).toEqual([
      { field: 'phone', submitted: '+54 11 5555 0000', onFile: '+54 11 4444 1111' },
    ]);
  });

  it('does not count a phone written differently as a difference', () => {
    expect(
      identityDifferences(onFile, {
        ...onFile,
        phone: '(011) 4444-1111'.replace('(011)', '+54 11'),
      }),
    ).toEqual([]);
  });

  it('does not count accents, case or the address of an email in another case', () => {
    expect(
      identityDifferences(onFile, {
        ...onFile,
        givenNames: 'LUCIA',
        familyName: 'fernandez',
        email: 'Lucia@Example.TEST',
      }),
    ).toEqual([]);
  });

  it('lists a different name, birth date and email', () => {
    const fields = identityDifferences(onFile, {
      givenNames: 'Marta',
      familyName: 'Gómez',
      birthDate: '1985-01-01',
      phone: onFile.phone,
      email: 'otra@example.test',
    }).map((difference) => difference.field);

    expect(fields).toEqual(['givenNames', 'familyName', 'birthDate', 'email']);
  });

  it('shows an empty value on file as null, and ignores a datum the form did not give', () => {
    expect(
      identityDifferences({ ...onFile, phone: null }, { ...onFile, phone: '+54 11 5555 0000' }),
    ).toEqual([{ field: 'phone', submitted: '+54 11 5555 0000', onFile: null }]);
    expect(identityDifferences(onFile, { ...onFile, phone: null })).toEqual([]);
  });
});
