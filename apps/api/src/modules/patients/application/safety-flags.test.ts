import { EMPTY_ANAMNESIS, SAFETY_FLAG_CODES, type AnamnesisContent } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { computeSafetyFlags } from './safety-flags.js';

const content = (patch: Partial<AnamnesisContent>): AnamnesisContent => ({
  ...EMPTY_ANAMNESIS,
  ...patch,
});

describe('computeSafetyFlags', () => {
  it('raises nothing for an empty anamnesis', () => {
    expect(computeSafetyFlags(EMPTY_ANAMNESIS)).toEqual([]);
  });

  it('raises allergy_on_file as soon as one allergy is recorded, whatever it is', () => {
    expect(
      computeSafetyFlags(content({ allergies: [{ substance: 'Penicilina', severity: 'severe' }] })),
    ).toEqual(['allergy_on_file']);
    expect(computeSafetyFlags(content({ allergies: [{ substance: 'Polen' }] }))).toEqual([
      'allergy_on_file',
    ]);
  });

  it('raises anticoagulant_on_file from a medication marked as one, or from the indicator', () => {
    expect(
      computeSafetyFlags(content({ medications: [{ name: 'Acenocumarol', anticoagulant: true }] })),
    ).toEqual(['anticoagulant_on_file']);
    expect(
      computeSafetyFlags(
        content({ indicators: { pregnant: false, implantedDevice: false, anticoagulated: true } }),
      ),
    ).toEqual(['anticoagulant_on_file']);
    expect(
      computeSafetyFlags(content({ medications: [{ name: 'Ibuprofeno', anticoagulant: false }] })),
    ).toEqual([]);
  });

  it('raises pregnancy and implanted_device from their indicators', () => {
    expect(
      computeSafetyFlags(
        content({ indicators: { pregnant: true, implantedDevice: true, anticoagulated: false } }),
      ),
    ).toEqual(['pregnancy', 'implanted_device']);
  });

  it('does not raise a flag for conditions or antecedents in free text', () => {
    expect(
      computeSafetyFlags(
        content({
          conditions: [{ name: 'Hipertensión' }],
          antecedents: 'Alergia a la penicilina y embarazo previo',
        }),
      ),
    ).toEqual([]);
  });

  it('returns codes in the order of the catalog, each once, and only known ones', () => {
    const flags = computeSafetyFlags(
      content({
        allergies: [{ substance: 'A' }, { substance: 'B' }],
        medications: [{ name: 'X', anticoagulant: true }],
        indicators: { pregnant: true, implantedDevice: true, anticoagulated: true },
      }),
    );

    expect(flags).toEqual([...SAFETY_FLAG_CODES]);
  });

  it('follows the anamnesis: removing the only allergy removes the flag', () => {
    const withAllergy = content({ allergies: [{ substance: 'Látex' }] });
    const without = { ...withAllergy, allergies: [] };

    expect(computeSafetyFlags(withAllergy)).toContain('allergy_on_file');
    expect(computeSafetyFlags(without)).not.toContain('allergy_on_file');
  });
});
