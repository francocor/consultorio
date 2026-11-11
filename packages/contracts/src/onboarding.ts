import { z } from 'zod';

import { MatriculaInput, ProfessionalProfileRequest } from './staff.js';

/**
 * Contracts of the guided first run (tenant-onboarding, Part A): the setup wizard, the solo fast
 * path and the first-run checklist. The tenant is never a field (it comes from the session), and
 * nothing here carries patient data: the wizard never asks for any.
 */

// The wizard ---------------------------------------------------------------------------------

/**
 * The steps of the setup wizard, in the order a person meets them. `billing` exists in the catalog
 * so the rule "a step of a capability this deployment lacks is never shown" has something to hide;
 * it appears only when billing is available.
 */
export const WIZARD_STEPS = [
  'profile',
  'location',
  'hours',
  'appointment_types',
  'team',
  'branding',
  'billing',
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** What is needed to book a first appointment: a location, working hours and an appointment type. */
const REQUIRED_STEPS: readonly WizardStep[] = ['location', 'hours', 'appointment_types'];

/** Required steps cannot be skipped and block the end of the wizard until their data exists. */
export function isRequiredStep(step: WizardStep): boolean {
  return REQUIRED_STEPS.includes(step);
}

export const WIZARD_STEP_STATUSES = ['pending', 'done', 'skipped'] as const;
export type WizardStepStatus = (typeof WIZARD_STEP_STATUSES)[number];

/** What a missing required step needs, named for the person ("create a location"). */
export const WIZARD_PREREQUISITES = [
  'location',
  'professional',
  'hours',
  'appointment_type',
] as const;
export type WizardPrerequisite = (typeof WIZARD_PREREQUISITES)[number];

export const WIZARD_PATHS = ['solo', 'center'] as const;
export type WizardPath = (typeof WIZARD_PATHS)[number];

/** What the owner answered, kept so the wizard resumes with its previous answers. */
export const WizardAnswers = z.strictObject({
  /** "Are you a health professional?" */
  isProfessional: z.boolean().optional(),
  path: z.enum(WIZARD_PATHS).optional(),
});
export type WizardAnswers = z.infer<typeof WizardAnswers>;

export const WizardStepDto = z.strictObject({
  id: z.enum(WIZARD_STEPS),
  status: z.enum(WIZARD_STEP_STATUSES),
  required: z.boolean(),
});
export type WizardStepDto = z.infer<typeof WizardStepDto>;

// The checklist ------------------------------------------------------------------------------

/** What is left to set up, computed from real data, never from a click. */
export const CHECKLIST_ITEMS = [
  'location',
  'hours',
  'appointment_type',
  'first_patient',
  'first_appointment',
  'matricula',
  'invite_staff',
  'branding',
] as const;
export type ChecklistItemId = (typeof CHECKLIST_ITEMS)[number];

export const ChecklistItemDto = z.strictObject({
  id: z.enum(CHECKLIST_ITEMS),
  done: z.boolean(),
});
export type ChecklistItemDto = z.infer<typeof ChecklistItemDto>;

// The state ----------------------------------------------------------------------------------

export const OnboardingStateDto = z.strictObject({
  wizard: z.strictObject({
    completed: z.boolean(),
    completedAt: z.iso.datetime().nullable(),
    /** Where the wizard resumes. Null once it is completed. */
    currentStep: z.enum(WIZARD_STEPS).nullable(),
    answers: WizardAnswers,
    /** Only the steps this deployment has. */
    steps: z.array(WizardStepDto),
    /** What is still missing to book a first appointment; empty when the wizard can be finished. */
    missing: z.array(z.enum(WIZARD_PREREQUISITES)),
  }),
  checklist: z.strictObject({
    dismissed: z.boolean(),
    /** Only the items of capabilities this deployment has. */
    items: z.array(ChecklistItemDto),
  }),
});
export type OnboardingStateDto = z.infer<typeof OnboardingStateDto>;

/**
 * One change to the saved progress. The client can mark a step done or skipped, move the cursor,
 * remember an answer or dismiss (or bring back) the checklist; it cannot mark a step pending,
 * complete the wizard (that is its own action, checked against real data) or name a tenant.
 */
export const UpdateOnboardingStateRequest = z
  .strictObject({
    step: z
      .strictObject({
        id: z.enum(WIZARD_STEPS),
        status: z.enum(['done', 'skipped']),
      })
      .optional(),
    currentStep: z.enum(WIZARD_STEPS).optional(),
    answers: WizardAnswers.optional(),
    checklistDismissed: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateOnboardingStateRequest = z.infer<typeof UpdateOnboardingStateRequest>;

// The "are you a professional?" step -----------------------------------------------------------

/**
 * Yes: the owner gets a professional profile (the matricula is optional here; without it the
 * profile is incomplete and opens nothing clinical). No: the owner keeps no clinical access and the
 * wizard asks them to bring a professional in.
 */
export const ProfessionalStepRequest = z.discriminatedUnion('isProfessional', [
  z.strictObject({
    isProfessional: z.literal(true),
    fullName: ProfessionalProfileRequest.shape.fullName,
    specialties: ProfessionalProfileRequest.shape.specialties,
    // Decision D21 (revised): the owner is a professional only with a complete profile, so the
    // registration with its jurisdiction is required here.
    matricula: MatriculaInput,
  }),
  z.strictObject({ isProfessional: z.literal(false) }),
]);
export type ProfessionalStepRequest = z.infer<typeof ProfessionalStepRequest>;

// The solo fast path -------------------------------------------------------------------------

/**
 * Who the professional is; everything else gets a sensible default that can be edited afterwards.
 * The owner who attends needs a complete professional profile (decision D21, revised): name,
 * specialty and the registration with its jurisdiction. The registration is optional in the shape
 * only because an owner who already has a profile has nothing to add; the service requires it
 * whenever the fast path has to create the profile. Branding and payment are not asked: they stay
 * as checklist items.
 */
export const FastPathRequest = z.strictObject({
  fullName: ProfessionalProfileRequest.shape.fullName,
  specialties: ProfessionalProfileRequest.shape.specialties,
  matricula: MatriculaInput.optional(),
  /** Name of the first location. Defaults to "Consultorio". */
  locationName: z.string().trim().min(1).max(120).optional(),
});
export type FastPathRequest = z.infer<typeof FastPathRequest>;

export const FastPathResponse = z.strictObject({
  state: OnboardingStateDto,
  /** What the fast path created now; an existing piece is reused, never duplicated. */
  created: z.strictObject({
    professional: z.boolean(),
    location: z.boolean(),
    hours: z.boolean(),
    appointmentType: z.boolean(),
  }),
  /** True when a first appointment can be booked right away. */
  readyToBook: z.boolean(),
});
export type FastPathResponse = z.infer<typeof FastPathResponse>;

// Staff invitations from the first run -------------------------------------------------------

/**
 * What inviting someone would change in the plan, shown BEFORE sending (staff-professionals,
 * tenant-onboarding "Staff invitation from the first run"). Until subscriptions exist nothing
 * changes the plan, so `affectsPlan` is always false.
 */
export const InvitationImpactDto = z.strictObject({
  affectsPlan: z.boolean(),
});
export type InvitationImpactDto = z.infer<typeof InvitationImpactDto>;
