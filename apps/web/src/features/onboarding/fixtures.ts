import type {
  ChecklistItemDto,
  OnboardingStateDto,
  WizardStep,
  WizardStepDto,
} from '@consultorio/contracts';

/** The six steps of a deployment with patients, scheduling and branding, as the API lists them. */
const STEP_ORDER: readonly WizardStep[] = [
  'profile',
  'location',
  'hours',
  'appointment_types',
  'team',
  'branding',
];
const REQUIRED: readonly WizardStep[] = ['location', 'hours', 'appointment_types'];

const ITEM_ORDER: readonly ChecklistItemDto['id'][] = [
  'location',
  'hours',
  'appointment_type',
  'first_patient',
  'first_appointment',
  'matricula',
  'invite_staff',
  'branding',
];

export interface StateOptions {
  completed?: boolean;
  currentStep?: WizardStep | null;
  /** Steps that are done (or skipped), by id. */
  steps?: Partial<Record<WizardStep, 'done' | 'skipped'>>;
  answers?: OnboardingStateDto['wizard']['answers'];
  missing?: readonly OnboardingStateDto['wizard']['missing'][number][];
  dismissed?: boolean;
  /** Checklist items that are done. */
  done?: readonly ChecklistItemDto['id'][];
}

/** The state `GET /onboarding/state` would return. A fresh organization by default. */
export function stateFor(options: StateOptions = {}): OnboardingStateDto {
  const completed = options.completed ?? false;
  const steps: WizardStepDto[] = STEP_ORDER.map((id) => ({
    id,
    status: options.steps?.[id] ?? 'pending',
    required: REQUIRED.includes(id),
  }));
  return {
    wizard: {
      completed,
      completedAt: completed ? '2026-10-17T12:00:00.000Z' : null,
      currentStep: completed ? null : (options.currentStep ?? 'profile'),
      answers: options.answers ?? {},
      steps,
      missing: options.missing
        ? [...options.missing]
        : completed
          ? []
          : ['location', 'professional', 'appointment_type'],
    },
    checklist: {
      dismissed: options.dismissed ?? false,
      items: ITEM_ORDER.map((id) => ({ id, done: options.done?.includes(id) ?? false })),
    },
  };
}
