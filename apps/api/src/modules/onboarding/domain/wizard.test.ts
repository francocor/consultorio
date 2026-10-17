import { describe, expect, it } from 'vitest';

import { DEFAULT_CAPABILITIES } from './capabilities.js';
import type { OnboardingFacts } from './facts.js';
import {
  buildWizard,
  canSkip,
  missingPrerequisites,
  stepsFor,
  type WizardRecord,
} from './wizard.js';

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

const READY: OnboardingFacts = {
  ...EMPTY,
  locations: 1,
  professionals: 1,
  professionalsWithHours: 1,
  appointmentTypes: 1,
};

const FRESH: WizardRecord = {
  progress: {},
  answers: {},
  currentStep: null,
  completedAt: null,
};

describe('the steps of a deployment', () => {
  it('are the six of the wizard, without a step for a capability that is not available', () => {
    expect(stepsFor(DEFAULT_CAPABILITIES)).toEqual([
      'profile',
      'location',
      'hours',
      'appointment_types',
      'team',
      'branding',
    ]);
  });

  it('shows the billing step only when billing is available', () => {
    expect(stepsFor(new Set([...DEFAULT_CAPABILITIES, 'billing'])).at(-1)).toBe('billing');
    expect(stepsFor(DEFAULT_CAPABILITIES)).not.toContain('billing');
  });

  it('leaves out hours and appointment types when there is no scheduling', () => {
    expect(stepsFor(new Set(['patients', 'branding'] as const))).toEqual([
      'profile',
      'location',
      'team',
      'branding',
    ]);
  });
});

describe('what is missing to book a first appointment', () => {
  it('is everything for an empty organization', () => {
    expect(missingPrerequisites(EMPTY, DEFAULT_CAPABILITIES)).toEqual([
      'location',
      'professional',
      'appointment_type',
    ]);
  });

  it('asks for hours once there is a professional but none has hours', () => {
    expect(
      missingPrerequisites({ ...EMPTY, locations: 1, professionals: 1 }, DEFAULT_CAPABILITIES),
    ).toEqual(['hours', 'appointment_type']);
  });

  it('is empty when a location, a professional with hours and a type exist', () => {
    expect(missingPrerequisites(READY, DEFAULT_CAPABILITIES)).toEqual([]);
  });

  it('does not ask for hours or a type when the deployment has no scheduling', () => {
    expect(
      missingPrerequisites(
        { ...EMPTY, locations: 1, professionals: 1 },
        new Set(['patients', 'branding'] as const),
      ),
    ).toEqual([]);
  });
});

describe('the wizard view', () => {
  it('starts at the first step with every step pending and the required ones marked', () => {
    const view = buildWizard(FRESH, EMPTY, DEFAULT_CAPABILITIES);

    expect(view.currentStep).toBe('profile');
    expect(view.completed).toBe(false);
    expect(view.steps.map((step) => [step.id, step.status, step.required])).toEqual([
      ['profile', 'pending', false],
      ['location', 'pending', true],
      ['hours', 'pending', true],
      ['appointment_types', 'pending', true],
      ['team', 'pending', false],
      ['branding', 'pending', false],
    ]);
  });

  it('resumes where the person left, with the previous answers', () => {
    const view = buildWizard(
      {
        ...FRESH,
        progress: { profile: 'done', location: 'done' },
        answers: { isProfessional: true },
        currentStep: 'hours',
      },
      { ...EMPTY, locations: 1, professionals: 1 },
      DEFAULT_CAPABILITIES,
    );

    expect(view.currentStep).toBe('hours');
    expect(view.answers).toEqual({ isProfessional: true });
  });

  it('marks a required step done from data, not from a click', () => {
    const view = buildWizard(FRESH, { ...EMPTY, locations: 1 }, DEFAULT_CAPABILITIES);

    expect(view.steps.find((step) => step.id === 'location')?.status).toBe('done');
    expect(view.steps.find((step) => step.id === 'hours')?.status).toBe('pending');
  });

  it('moves the cursor to the first open step when none was saved', () => {
    const view = buildWizard(
      { ...FRESH, progress: { profile: 'done' }, answers: { isProfessional: true } },
      { ...EMPTY, locations: 1 },
      DEFAULT_CAPABILITIES,
    );

    expect(view.currentStep).toBe('hours');
  });

  it('reports a skipped optional step as skipped and does not stop on it', () => {
    const view = buildWizard(
      { ...FRESH, progress: { profile: 'done', team: 'skipped' }, currentStep: 'team' },
      READY,
      DEFAULT_CAPABILITIES,
    );

    expect(view.steps.find((step) => step.id === 'team')?.status).toBe('skipped');
  });

  it('has no current step once completed, and reports when', () => {
    const view = buildWizard(
      { ...FRESH, completedAt: new Date('2026-10-17T12:00:00Z'), currentStep: 'hours' },
      READY,
      DEFAULT_CAPABILITIES,
    );

    expect(view.completed).toBe(true);
    expect(view.completedAt).toBe('2026-10-17T12:00:00.000Z');
    expect(view.currentStep).toBeNull();
  });

  it('ignores a saved step the deployment does not have', () => {
    const view = buildWizard({ ...FRESH, currentStep: 'billing' }, EMPTY, DEFAULT_CAPABILITIES);

    expect(view.currentStep).toBe('profile');
  });

  it('lists what is missing so the wizard cannot be finished early', () => {
    expect(buildWizard(FRESH, EMPTY, DEFAULT_CAPABILITIES).missing).toEqual([
      'location',
      'professional',
      'appointment_type',
    ]);
    expect(buildWizard(FRESH, READY, DEFAULT_CAPABILITIES).missing).toEqual([]);
  });
});

describe('which steps can be skipped', () => {
  it.each(['profile', 'team', 'branding'] as const)('lets "%s" be skipped', (step) => {
    expect(canSkip(step)).toBe(true);
  });

  it.each(['location', 'hours', 'appointment_types'] as const)(
    'never lets the required "%s" be skipped',
    (step) => {
      expect(canSkip(step)).toBe(false);
    },
  );
});
