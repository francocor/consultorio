import { describe, expect, it } from 'vitest';

import {
  CHECKLIST_ITEMS,
  FastPathRequest,
  OnboardingStateDto,
  ProfessionalStepRequest,
  UpdateOnboardingStateRequest,
  WIZARD_STEPS,
  isRequiredStep,
} from './onboarding.js';
import { GRANTABLE, ROLE_PERMISSIONS } from './roles.js';

describe('the wizard and the checklist catalogs', () => {
  it('lists the steps of the setup wizard in the order a person meets them', () => {
    expect([...WIZARD_STEPS]).toEqual([
      'profile',
      'location',
      'hours',
      'appointment_types',
      'team',
      'branding',
      'billing',
    ]);
  });

  it('requires exactly what is needed to book a first appointment', () => {
    const required = WIZARD_STEPS.filter((step) => isRequiredStep(step));
    expect(required).toEqual(['location', 'hours', 'appointment_types']);
    expect(isRequiredStep('branding')).toBe(false);
    expect(isRequiredStep('team')).toBe(false);
  });

  it('lists the eight checklist items of the spec', () => {
    expect([...CHECKLIST_ITEMS]).toEqual([
      'location',
      'hours',
      'appointment_type',
      'first_patient',
      'first_appointment',
      'matricula',
      'invite_staff',
      'branding',
    ]);
  });
});

describe('UpdateOnboardingStateRequest', () => {
  it('accepts one change at a time', () => {
    expect(
      UpdateOnboardingStateRequest.safeParse({ step: { id: 'branding', status: 'skipped' } })
        .success,
    ).toBe(true);
    expect(UpdateOnboardingStateRequest.safeParse({ checklistDismissed: true }).success).toBe(true);
    expect(UpdateOnboardingStateRequest.safeParse({ currentStep: 'hours' }).success).toBe(true);
  });

  it('rejects an empty change, an unknown step and a step marked pending by the client', () => {
    expect(UpdateOnboardingStateRequest.safeParse({}).success).toBe(false);
    expect(
      UpdateOnboardingStateRequest.safeParse({ step: { id: 'nope', status: 'done' } }).success,
    ).toBe(false);
    expect(
      UpdateOnboardingStateRequest.safeParse({ step: { id: 'hours', status: 'pending' } }).success,
    ).toBe(false);
  });

  it('never accepts a tenant, a completion time or a field it does not know', () => {
    expect(
      UpdateOnboardingStateRequest.safeParse({ checklistDismissed: true, tenantId: 'x' }).success,
    ).toBe(false);
    expect(
      UpdateOnboardingStateRequest.safeParse({ wizardCompletedAt: '2026-01-01T00:00:00Z' }).success,
    ).toBe(false);
  });
});

describe('ProfessionalStepRequest', () => {
  const MATRICULA = { jurisdiction: 'AR-B', number: 'MP 12345' };

  it('needs the name, a specialty and the matricula when the owner is a professional (D21)', () => {
    expect(
      ProfessionalStepRequest.safeParse({
        isProfessional: true,
        fullName: 'Dra. Ana Perez',
        specialties: ['Clinica medica'],
        matricula: MATRICULA,
      }).success,
    ).toBe(true);
    expect(
      ProfessionalStepRequest.safeParse({
        isProfessional: true,
        fullName: 'Dra. Ana Perez',
        specialties: [],
        matricula: MATRICULA,
      }).success,
    ).toBe(false);
  });

  it('does not take a missing matricula: the role is only active with the profile (D21)', () => {
    const base = { isProfessional: true, fullName: 'Dra. Ana Perez', specialties: ['Clinica'] };
    expect(ProfessionalStepRequest.safeParse({ ...base, matricula: null }).success).toBe(false);
    expect(ProfessionalStepRequest.safeParse(base).success).toBe(false);
    expect(
      ProfessionalStepRequest.safeParse({ ...base, matricula: { jurisdiction: 'AR-B' } }).success,
    ).toBe(false);
  });

  it('is just the answer when the owner is not a professional', () => {
    expect(ProfessionalStepRequest.safeParse({ isProfessional: false }).success).toBe(true);
    expect(
      ProfessionalStepRequest.safeParse({ isProfessional: false, fullName: 'Ana' }).success,
    ).toBe(false);
  });
});

describe('FastPathRequest', () => {
  it('asks who the professional is, with the matricula (D21), and nothing about hours or payment', () => {
    const parsed = FastPathRequest.safeParse({
      fullName: 'Lic. Mario Gomez',
      specialties: ['Psicologia'],
      matricula: { jurisdiction: 'AR-B', number: 'MP 12345' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.locationName).toBeUndefined();
  });

  it('accepts no matricula in the shape (an owner who already has a profile needs none) but never a malformed one', () => {
    expect(
      FastPathRequest.safeParse({ fullName: 'Lic. Mario Gomez', specialties: ['Psicologia'] })
        .success,
    ).toBe(true);
    expect(
      FastPathRequest.safeParse({
        fullName: 'Lic. Mario Gomez',
        specialties: ['Psicologia'],
        matricula: null,
      }).success,
    ).toBe(false);
  });
});

describe('OnboardingStateDto', () => {
  it('describes the wizard and the checklist in one answer', () => {
    const state = OnboardingStateDto.parse({
      wizard: {
        completed: false,
        completedAt: null,
        currentStep: 'hours',
        answers: { isProfessional: true },
        steps: [{ id: 'hours', status: 'pending', required: true }],
        missing: ['hours'],
      },
      checklist: {
        dismissed: false,
        items: [{ id: 'location', done: true }],
      },
    });
    expect(state.wizard.missing).toEqual(['hours']);
    expect(state.checklist.items[0]).toEqual({ id: 'location', done: true });
  });
});

describe('the permission to run the wizard', () => {
  it('belongs to the owner, and an admin gets it only by an explicit grant', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('onboarding.manage');
    expect(ROLE_PERMISSIONS.admin).not.toContain('onboarding.manage');
    expect(ROLE_PERMISSIONS.reception).not.toContain('onboarding.manage');
    expect(ROLE_PERMISSIONS.professional).not.toContain('onboarding.manage');
    expect(ROLE_PERMISSIONS.patient).not.toContain('onboarding.manage');
    expect(GRANTABLE).toContain('onboarding.manage');
  });
});
