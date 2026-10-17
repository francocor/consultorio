import type { ProfessionalDto, StaffMemberDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { needsConfirmation, parseCapacity, profileRequestFor } from './overbooking.js';

describe('parseCapacity', () => {
  it('accepts whole numbers from 1 to 20', () => {
    expect(parseCapacity('1')).toBe(1);
    expect(parseCapacity(' 2 ')).toBe(2);
    expect(parseCapacity('20')).toBe(20);
  });

  it('refuses everything else', () => {
    for (const text of ['', '0', '21', '-1', '1.5', 'dos', '1e1']) {
      expect(parseCapacity(text), text).toBeNull();
    }
  });
});

describe('needsConfirmation', () => {
  it('asks when overbooking is switched on or raised, never when it goes back to one', () => {
    expect(needsConfirmation(1, 2)).toBe(true);
    expect(needsConfirmation(2, 3)).toBe(true);
    expect(needsConfirmation(3, 1)).toBe(false);
    expect(needsConfirmation(2, 2)).toBe(false);
    expect(needsConfirmation(1, 1)).toBe(false);
  });

  it('does not ask when the value is lowered but still above one', () => {
    expect(needsConfirmation(4, 2)).toBe(false);
  });
});

describe('profileRequestFor', () => {
  const profile: ProfessionalDto = {
    id: '0190a000-0000-7000-8000-00000000000a',
    membershipId: '0190a000-0000-7000-8000-0000000000a2',
    fullName: 'Dra. Ana Pérez',
    status: 'active',
    specialties: ['Cardiología'],
    matricula: { jurisdiction: 'AR-C', number: '41258', status: 'verified' },
    maxSimultaneous: 1,
    clinicalAccess: true,
  };
  const member = { displayName: 'Ana (directorio)' } as StaffMemberDto;

  it('keeps everything about the professional and changes only the capacity', () => {
    expect(profileRequestFor(profile, member, 3)).toEqual({
      fullName: 'Dra. Ana Pérez',
      specialties: ['Cardiología'],
      matricula: { jurisdiction: 'AR-C', number: '41258' },
      maxSimultaneous: 3,
    });
  });

  it('keeps a missing registration missing, and falls back to the name in the directory', () => {
    expect(profileRequestFor({ ...profile, fullName: null, matricula: null }, member, 2)).toEqual({
      fullName: 'Ana (directorio)',
      specialties: ['Cardiología'],
      matricula: null,
      maxSimultaneous: 2,
    });
  });

  it('cannot save a profile without a discipline, which the API requires', () => {
    expect(profileRequestFor({ ...profile, specialties: [] }, member, 2)).toBeNull();
  });
});
