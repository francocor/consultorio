import { EMPTY_ANAMNESIS, type AnamnesisContent } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import {
  deriveSafetyFlags,
  EMPTY_ANAMNESIS_FORM,
  toAnamnesisContent,
  valuesFromAnamnesis,
  type AnamnesisFormValues,
} from './anamnesis.js';

const filled: AnamnesisContent = {
  allergies: [{ substance: 'Penicilina', reaction: 'Urticaria', severity: 'severe' }],
  medications: [{ name: 'Acenocumarol', dose: '2 mg', anticoagulant: true }],
  conditions: [{ name: 'Hipertensión', since: '2019' }],
  antecedents: 'Madre con diabetes.',
  indicators: { pregnant: false, implantedDevice: true, anticoagulated: false },
};

describe('deriveSafetyFlags', () => {
  it('raises nothing for an empty anamnesis', () => {
    expect(deriveSafetyFlags(EMPTY_ANAMNESIS)).toEqual([]);
  });

  it('raises one flag per structured fact, in the order of the catalog', () => {
    expect(deriveSafetyFlags(filled)).toEqual([
      'allergy_on_file',
      'anticoagulant_on_file',
      'implanted_device',
    ]);
  });

  it('an anticoagulated indicator is enough, without a listed medication', () => {
    expect(
      deriveSafetyFlags({
        ...EMPTY_ANAMNESIS,
        indicators: { ...EMPTY_ANAMNESIS.indicators, anticoagulated: true },
      }),
    ).toEqual(['anticoagulant_on_file']);
  });

  it('pregnancy is its own flag', () => {
    expect(
      deriveSafetyFlags({
        ...EMPTY_ANAMNESIS,
        indicators: { ...EMPTY_ANAMNESIS.indicators, pregnant: true },
      }),
    ).toEqual(['pregnancy']);
  });

  it('free text never raises a flag', () => {
    expect(
      deriveSafetyFlags({ ...EMPTY_ANAMNESIS, antecedents: 'Alergia a la penicilina, embarazada' }),
    ).toEqual([]);
  });
});

describe('the form and the content', () => {
  it('start empty', () => {
    expect(toAnamnesisContent(EMPTY_ANAMNESIS_FORM)).toEqual(EMPTY_ANAMNESIS);
  });

  it('round-trips a full anamnesis', () => {
    expect(toAnamnesisContent(valuesFromAnamnesis(filled))).toEqual(filled);
  });

  it('drops the rows nobody filled in and the optional text left blank', () => {
    const values: AnamnesisFormValues = {
      ...EMPTY_ANAMNESIS_FORM,
      allergies: [
        { substance: '  Látex ', reaction: '', severity: '' },
        { substance: '', reaction: 'sin sustancia', severity: 'mild' },
      ],
      medications: [{ name: '', dose: '', anticoagulant: false }],
      conditions: [{ name: 'Asma', since: ' ' }],
    };

    expect(toAnamnesisContent(values)).toEqual({
      ...EMPTY_ANAMNESIS,
      allergies: [{ substance: 'Látex' }],
      conditions: [{ name: 'Asma' }],
    });
  });

  it('keeps the anticoagulant mark only when it is on', () => {
    const values: AnamnesisFormValues = {
      ...EMPTY_ANAMNESIS_FORM,
      medications: [
        { name: 'Warfarina', dose: '', anticoagulant: true },
        { name: 'Enalapril', dose: '10 mg', anticoagulant: false },
      ],
    };

    expect(toAnamnesisContent(values).medications).toEqual([
      { name: 'Warfarina', anticoagulant: true },
      { name: 'Enalapril', dose: '10 mg' },
    ]);
  });
});
