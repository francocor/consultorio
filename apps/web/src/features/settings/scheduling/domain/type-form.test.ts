import type { AppointmentTypeDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { diffType, typeToForm, validateType, type TypeFormValues } from './type-form.js';

const PRO = '0190a000-0000-7000-8000-00000000000a';

const BLANK: TypeFormValues = {
  name: '',
  description: '',
  durationMinutes: '',
  bufferMinutes: '0',
  mode: 'in_person',
  requiresApproval: false,
  color: '',
  professionalIds: [],
};

function form(overrides: Partial<TypeFormValues>): TypeFormValues {
  return { ...BLANK, name: 'Primera consulta', durationMinutes: '45', ...overrides };
}

describe('validateType', () => {
  it('turns a filled form into the request the API takes', () => {
    const result = validateType(form({ description: ' Primera visita ', color: '#0f766e' }));

    expect(result).toEqual({
      ok: true,
      request: {
        name: 'Primera consulta',
        description: 'Primera visita',
        durationMinutes: 45,
        bufferMinutes: 0,
        mode: 'in_person',
        requiresApproval: false,
        color: '#0f766e',
        professionalIds: [],
        specialties: [],
      },
    });
  });

  it('leaves out an empty description and an empty color', () => {
    const result = validateType(form({}));

    expect(result.ok && result.request.description).toBeNull();
    expect(result.ok && result.request.color).toBeNull();
  });

  it('rejects a duration of zero or less, as the spec says', () => {
    for (const duration of ['0', '-5', '', 'abc', '1441', '30.5']) {
      const result = validateType(form({ durationMinutes: duration }));
      expect(result.ok, duration).toBe(false);
      expect(!result.ok && result.errors.durationMinutes, duration).toBe('duration');
    }
  });

  it('rejects an empty name, a negative buffer and a color that is not #rrggbb', () => {
    const result = validateType(form({ name: '   ', bufferMinutes: '-1', color: 'verde' }));

    expect(result).toEqual({
      ok: false,
      errors: { name: 'name', bufferMinutes: 'buffer', color: 'color' },
    });
  });

  it('accepts a buffer of zero and the longest allowed duration', () => {
    expect(validateType(form({ durationMinutes: '1440', bufferMinutes: '0' })).ok).toBe(true);
    expect(validateType(form({ durationMinutes: '1', bufferMinutes: '1440' })).ok).toBe(true);
  });
});

describe('editing an existing type', () => {
  const existing: AppointmentTypeDto = {
    id: '0190a000-0000-7000-8000-0000000000d1',
    name: 'Control',
    description: null,
    durationMinutes: 20,
    bufferMinutes: 5,
    mode: 'in_person',
    priceReference: 'ctrl-1',
    requiresApproval: false,
    color: '#1d4ed8',
    professionalIds: [PRO],
    specialties: ['Cardiología'],
    active: true,
  };

  it('fills the form from the type', () => {
    expect(typeToForm(existing)).toEqual({
      name: 'Control',
      description: '',
      durationMinutes: '20',
      bufferMinutes: '5',
      mode: 'in_person',
      requiresApproval: false,
      color: '#1d4ed8',
      professionalIds: [PRO],
    });
  });

  it('sends only what changed', () => {
    const result = validateType({
      ...typeToForm(existing),
      durationMinutes: '30',
      requiresApproval: true,
    });
    if (!result.ok) throw new Error('should be valid');

    expect(diffType(existing, result.request)).toEqual({
      durationMinutes: 30,
      requiresApproval: true,
    });
  });

  it('keeps the price reference and the disciplines the form does not show', () => {
    const result = validateType({ ...typeToForm(existing), name: 'Control anual' });
    if (!result.ok) throw new Error('should be valid');

    const patch = diffType(existing, result.request);
    expect(patch).toEqual({ name: 'Control anual' });
    expect(patch).not.toHaveProperty('priceReference');
    expect(patch).not.toHaveProperty('specialties');
  });

  it('has nothing to send when nothing changed', () => {
    const result = validateType(typeToForm(existing));
    if (!result.ok) throw new Error('should be valid');

    expect(diffType(existing, result.request)).toEqual({});
  });
});
