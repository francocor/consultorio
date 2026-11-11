import { describe, expect, it } from 'vitest';

import { EMPTY_ITEM, missingFields, requestItems, signatureOf, type ItemDraft } from './forms.js';

const complete: ItemDraft = {
  genericName: 'Amoxicilina',
  dose: '500 mg',
  form: 'comprimidos',
  quantity: '21',
  instructions: '1 cada 8 horas durante 7 días',
};

describe('the lines of a prescription as the form holds them', () => {
  it('starts empty, and an empty line misses every field', () => {
    expect(missingFields(EMPTY_ITEM)).toEqual([
      'genericName',
      'dose',
      'form',
      'quantity',
      'instructions',
    ]);
  });

  it('misses nothing when every field is filled in', () => {
    expect(missingFields(complete)).toEqual([]);
  });

  it('misses the field that is blank, spaces included, and only that one', () => {
    expect(missingFields({ ...complete, dose: '   ' })).toEqual(['dose']);
    expect(missingFields({ ...complete, instructions: '' })).toEqual(['instructions']);
  });

  it('misses a quantity that is not a whole number between 1 and 999', () => {
    for (const quantity of ['0', '-3', '2.5', 'dos', '1000', '']) {
      expect(missingFields({ ...complete, quantity }), quantity).toEqual(['quantity']);
    }
    expect(missingFields({ ...complete, quantity: ' 14 ' })).toEqual([]);
    expect(missingFields({ ...complete, quantity: '999' })).toEqual([]);
  });
});

describe('the request the form sends', () => {
  it('turns the lines into the shape of the contract: trimmed text and a whole quantity', () => {
    expect(
      requestItems([{ ...complete, genericName: '  Amoxicilina ', quantity: ' 21 ' }]),
    ).toEqual([
      {
        genericName: 'Amoxicilina',
        dose: '500 mg',
        form: 'comprimidos',
        quantity: 21,
        instructions: '1 cada 8 horas durante 7 días',
      },
    ]);
  });

  it('sends nothing while a line is incomplete, or there is no line', () => {
    expect(requestItems([complete, { ...complete, quantity: '' }])).toBeNull();
    expect(requestItems([])).toBeNull();
  });
});

describe('what makes two submissions the same one', () => {
  it('is the patient and the lines, so a double click is one prescription and a changed line is another', () => {
    const same = signatureOf('patient-1', [complete]);

    expect(signatureOf('patient-1', [{ ...complete }])).toBe(same);
    expect(signatureOf('patient-2', [complete])).not.toBe(same);
    expect(signatureOf('patient-1', [{ ...complete, quantity: '14' }])).not.toBe(same);
  });
});
