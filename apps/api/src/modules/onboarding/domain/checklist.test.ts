import { CHECKLIST_ITEMS } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CAPABILITIES } from './capabilities.js';
import { buildChecklist } from './checklist.js';
import type { OnboardingFacts } from './facts.js';

const EMPTY: OnboardingFacts = {
  locations: 0,
  professionals: 0,
  professionalsWithHours: 0,
  appointmentTypes: 0,
  patients: 0,
  appointments: 0,
  professionalsWithMatricula: 0,
  staffInvited: false,
  brandingConfigured: false,
};

const done = (facts: OnboardingFacts, capabilities = DEFAULT_CAPABILITIES) =>
  Object.fromEntries(buildChecklist(facts, capabilities).map((item) => [item.id, item.done]));

describe('the checklist is computed from real data', () => {
  it('is all pending for an organization that has nothing yet', () => {
    const items = buildChecklist(EMPTY, DEFAULT_CAPABILITIES);

    expect(items.map((item) => item.id)).toEqual([...CHECKLIST_ITEMS]);
    expect(items.every((item) => !item.done)).toBe(true);
  });

  it('completes "location" the moment a location exists, and only that item', () => {
    expect(done({ ...EMPTY, locations: 1 })).toEqual({
      location: true,
      hours: false,
      appointment_type: false,
      first_patient: false,
      first_appointment: false,
      matricula: false,
      invite_staff: false,
      branding: false,
    });
  });

  it.each([
    ['hours', { professionalsWithHours: 1 }],
    ['appointment_type', { appointmentTypes: 2 }],
    ['first_patient', { patients: 1 }],
    ['first_appointment', { appointments: 1 }],
    ['matricula', { professionalsWithMatricula: 1 }],
    ['invite_staff', { staffInvited: true }],
    ['branding', { brandingConfigured: true }],
  ] as const)('completes "%s" from its own piece of data', (id, patch) => {
    const result = done({ ...EMPTY, ...patch });

    expect(result[id]).toBe(true);
    expect(Object.values(result).filter(Boolean)).toHaveLength(1);
  });

  it('does not mark "hours" done because a professional exists without hours', () => {
    expect(done({ ...EMPTY, professionals: 1 })['hours']).toBe(false);
  });
});

describe('items of capabilities the deployment lacks', () => {
  it('are not shown', () => {
    const withoutBranding = buildChecklist(EMPTY, new Set(['patients', 'scheduling'] as const)).map(
      (item) => item.id,
    );

    expect(withoutBranding).not.toContain('branding');
    expect(withoutBranding).toContain('first_patient');
  });

  it('take their dependents with them: without scheduling there is no hours, type or booking', () => {
    const ids = buildChecklist(EMPTY, new Set(['patients', 'branding'] as const)).map(
      (item) => item.id,
    );

    expect(ids).toEqual(['location', 'first_patient', 'matricula', 'invite_staff', 'branding']);
  });
});
