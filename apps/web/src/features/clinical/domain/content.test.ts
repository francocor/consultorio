import { describe, expect, it } from 'vitest';

import { cleanContent, contentKey, fieldsOf, issueMap, numberFromInput } from './content.js';

describe('cleanContent', () => {
  it('drops blank text, missing numbers and empty lists, and keeps the rest as typed', () => {
    expect(
      cleanContent({
        reasonForConsultation: 'Control',
        symptoms: '   ',
        diagnosis: '',
        measurements: [],
        medications: [{ name: 'Enalapril', dose: '', frequency: undefined }],
        painIntensity: 0,
        sessionNumber: Number.NaN,
        done: false,
      }),
    ).toEqual({
      reasonForConsultation: 'Control',
      medications: [{ name: 'Enalapril' }],
      painIntensity: 0,
      done: false,
    });
  });

  it('drops a row of a list that nobody filled in', () => {
    expect(
      cleanContent({
        measurements: [
          { name: '', value: '', unit: '' },
          { name: 'Peso', value: '72' },
        ],
      }),
    ).toEqual({ measurements: [{ name: 'Peso', value: '72' }] });
  });

  it('drops empty objects at any depth (a tooth with nothing recorded)', () => {
    expect(
      cleanContent({
        odontogram: {
          '16': { condition: 'caries', surfaces: {} },
          '26': {},
          '36': { surfaces: { mesial: {} } },
        },
      }),
    ).toEqual({ odontogram: { '16': { condition: 'caries' } } });
  });

  it('trims text but never changes numbers', () => {
    expect(cleanContent({ a: '  hola ', b: 7.5 })).toEqual({ a: 'hola', b: 7.5 });
  });
});

describe('numberFromInput', () => {
  it('reads what the keyboard produced: empty is nothing, a comma is a decimal point', () => {
    expect(numberFromInput('')).toBeUndefined();
    expect(numberFromInput('  ')).toBeUndefined();
    expect(numberFromInput('72')).toBe(72);
    expect(numberFromInput('1,75')).toBe(1.75);
    expect(numberFromInput('0')).toBe(0);
    expect(numberFromInput('abc')).toBeUndefined();
    expect(numberFromInput(undefined)).toBeUndefined();
  });
});

describe('contentKey', () => {
  it('is the same for the same content however it was typed', () => {
    expect(contentKey({ a: 'x ', b: [] })).toBe(contentKey({ a: 'x' }));
    expect(contentKey({ a: 'x' })).not.toBe(contentKey({ a: 'y' }));
  });

  it('does not depend on the order of the fields', () => {
    expect(contentKey({ a: 1, b: 2 })).toBe(contentKey({ b: 2, a: 1 }));
  });
});

describe('issueMap', () => {
  it('indexes the field errors by path', () => {
    expect(
      issueMap([
        { path: 'heightM', i18nKey: 'clinical.nutrition.implausible' },
        { path: 'measurements.0.value', i18nKey: 'validation.required' },
      ]),
    ).toEqual({
      heightM: 'clinical.nutrition.implausible',
      'measurements.0.value': 'validation.required',
    });
  });
});

describe('fieldsOf', () => {
  it('lists the fields of each template in the order a person reads them', () => {
    expect(fieldsOf('general')).toEqual([
      'reasonForConsultation',
      'symptoms',
      'measurements',
      'diagnosis',
      'plan',
      'medications',
    ]);
    expect(fieldsOf('psychology')[0]).toBe('sessionDate');
    expect(fieldsOf('nutrition')).toContain('mealPlan');
    expect(fieldsOf('odontology')).toEqual([
      'reasonForConsultation',
      'odontogram',
      'notes',
      'treatmentPlan',
    ]);
  });
});
