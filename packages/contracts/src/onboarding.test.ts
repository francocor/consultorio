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
  it('needs the name and a specialty when the owner is a professional', () => {
    expect(
      ProfessionalStepRequest.safeParse({
        isProfessional: true,
        fullName: 'Dra. Ana Perez',
        specialties: ['Clinica medica'],
        matricula: null,
      }).success,
    ).toBe(true);
    expect(
      ProfessionalStepRequest.safeParse({
        isProfessional: true,
        fullName: 'Dra. Ana Perez',
        specialties: [],
        matricula: null,
      }).success,
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
  it('needs no matricula and no hours: only who the professional is', () => {
    const parsed = FastPathRequest.safeParse({
      fullName: 'Lic. Mario Gomez',
      specialties: ['Psicologia'],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.locationName).toBeUndefined();
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
