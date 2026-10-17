import type {
  AppointmentTypeDto,
  FastPathRequest,
  FastPathResponse,
  InvitationImpactDto,
  OnboardingStateDto,
  ProfessionalStepRequest,
  Role,
  StaffRole,
  UpdateOnboardingStateRequest,
  WizardPrerequisite,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { professional } from '../../../db/schema/staff.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import {
  AccessRefused,
  addProfessionalRoleToOwner,
  type LocationService,
} from '../../access/index.js';
import type { AppointmentTypeService } from '../../scheduling/index.js';
import type { HoursService, ProfileService } from '../../staff/index.js';
import type { Capabilities } from '../domain/capabilities.js';
import { buildChecklist } from '../domain/checklist.js';
import {
  defaultWeeklyHours,
  DEFAULT_APPOINTMENT_TYPE,
  DEFAULT_LOCATION_NAME,
} from '../domain/defaults.js';
import { buildWizard, canSkip, missingPrerequisites, stepsFor } from '../domain/wizard.js';

import { readFacts } from './facts.js';
import { isWizardCompleted, loadStored, saveStored, type StatePatch } from './store.js';

/** What inviting someone would change in the plan. A port: subscriptions plug in at Stage 6. */
export interface PlanImpact {
  preview(tx: Tx, input: { roles: readonly StaffRole[] }): Promise<InvitationImpactDto>;
}

/** Until subscriptions exist, no invitation changes the plan. */
export const noPlanImpact: PlanImpact = {
  preview: () => Promise.resolve({ affectsPlan: false }),
};

export interface OnboardingDeps {
  capabilities: Capabilities;
  locations: LocationService;
  hours: HoursService;
  profiles: ProfileService;
  types: AppointmentTypeService;
  /** Time zone of a new location, from the country pack of the organization. */
  defaultTimeZone: (country: string) => string;
  planImpact: PlanImpact;
  clock: () => Date;
}

/** Who runs the wizard: the person, their roles now, and the organization's country. */
export interface OnboardingActor {
  audit: AuditActor & { userId: string };
  membershipId: string;
  roles: readonly Role[];
  country: string;
}

export interface OnboardingService {
  get(tx: Tx): Promise<OnboardingStateDto>;
  update(
    tx: Tx,
    input: { actor: OnboardingActor; request: UpdateOnboardingStateRequest },
  ): Promise<OnboardingStateDto>;
  professionalStep(
    tx: Tx,
    input: { actor: OnboardingActor; request: ProfessionalStepRequest },
  ): Promise<OnboardingStateDto>;
  fastPath(
    tx: Tx,
    input: { actor: OnboardingActor; request: FastPathRequest },
  ): Promise<FastPathResponse>;
  complete(tx: Tx, input: { actor: OnboardingActor }): Promise<OnboardingStateDto>;
  invitationImpact(tx: Tx, roles: readonly StaffRole[]): Promise<InvitationImpactDto>;
}

const RESOURCE = 'onboarding';

function missingErrors(missing: readonly WizardPrerequisite[]) {
  return missing.map((item) => ({ path: item, i18nKey: `onboarding.missing.${item}` }));
}

export function createOnboardingService(deps: OnboardingDeps): OnboardingService {
  const available = stepsFor(deps.capabilities);

  async function view(tx: Tx): Promise<OnboardingStateDto> {
    const [stored, facts] = await Promise.all([loadStored(tx), readFacts(tx)]);
    return {
      wizard: buildWizard(stored, facts, deps.capabilities),
      checklist: {
        dismissed: stored.checklistDismissedAt !== null,
        items: buildChecklist(facts, deps.capabilities),
      },
    };
  }

  async function ownProfessional(tx: Tx, membershipId: string) {
    const [row] = await tx
      .select({ id: professional.id, status: professional.status })
      .from(professional)
      .where(eq(professional.membershipId, membershipId));
    return row;
  }

  /**
   * Makes the owner a professional (role and profile), saving the profile as given. Open only
   * while the wizard is not finished: after that, roles are not self-assigned (authorization,
   * "No self-assignment or silent escalation of roles"), another owner adds them.
   */
  async function makeOwnerProfessional(
    tx: Tx,
    actor: OnboardingActor,
    request: Extract<ProfessionalStepRequest, { isProfessional: true }>,
  ): Promise<void> {
    if (!actor.roles.includes('professional') && (await isWizardCompleted(tx))) {
      throw new AccessRefused('onboarding_role_closed');
    }
    await addProfessionalRoleToOwner(tx, {
      actor: actor.audit,
      membershipId: actor.membershipId,
    });
    await deps.profiles.save(tx, {
      actor: actor.audit,
      actorMembershipId: actor.membershipId,
      actorRoles: [...new Set<Role>([...actor.roles, 'professional'])],
      targetMembershipId: actor.membershipId,
      country: actor.country,
      request: {
        fullName: request.fullName,
        specialties: request.specialties,
        matricula: request.matricula,
      },
    });
  }

  return {
    get: view,

    async update(tx, { actor, request }) {
      const stored = await loadStored(tx);
      const patch: StatePatch = {};

      if (request.step) {
        const { id, status } = request.step;
        if (!available.includes(id)) {
          throw new AppError('validation_failed', [
            { path: 'step.id', i18nKey: 'onboarding.step_unavailable' },
          ]);
        }
        // A required step is finished by its data, never by a click, and is never skipped.
        if (!canSkip(id)) {
          throw new AppError('validation_failed', [
            { path: 'step.id', i18nKey: 'onboarding.step_required' },
          ]);
        }
        patch.progress = { ...stored.progress, [id]: status };
      }
      if (request.currentStep !== undefined) {
        if (!available.includes(request.currentStep)) {
          throw new AppError('validation_failed', [
            { path: 'currentStep', i18nKey: 'onboarding.step_unavailable' },
          ]);
        }
        patch.currentStep = request.currentStep;
      }
      if (request.answers !== undefined) {
        patch.answers = { ...stored.answers, ...request.answers };
      }
      const now = deps.clock();
      const dismissing = request.checklistDismissed;
      let dismissalAction:
        'onboarding.checklist_dismissed' | 'onboarding.checklist_restored' | null = null;
      if (dismissing === true && stored.checklistDismissedAt === null) {
        patch.checklistDismissed = { at: now, by: actor.audit.userId };
        dismissalAction = 'onboarding.checklist_dismissed';
      } else if (dismissing === false && stored.checklistDismissedAt !== null) {
        patch.checklistDismissed = null;
        dismissalAction = 'onboarding.checklist_restored';
      }

      await saveStored(tx, patch);

      if (request.step) {
        await audit(tx, {
          action: 'onboarding.step_updated',
          outcome: 'allow',
          actor: actor.audit,
          resourceType: RESOURCE,
          metadata: { step: request.step.id, status: request.step.status },
        });
      }
      if (dismissalAction) {
        await audit(tx, {
          action: dismissalAction,
          outcome: 'allow',
          actor: actor.audit,
          resourceType: RESOURCE,
        });
      }
      return view(tx);
    },

    async professionalStep(tx, { actor, request }) {
      if (request.isProfessional) await makeOwnerProfessional(tx, actor, request);
      const stored = await loadStored(tx);
      await saveStored(tx, {
        progress: { ...stored.progress, profile: 'done' },
        answers: { ...stored.answers, isProfessional: request.isProfessional },
      });
      await audit(tx, {
        action: 'onboarding.step_updated',
        outcome: 'allow',
        actor: actor.audit,
        resourceType: RESOURCE,
        metadata: { step: 'profile', status: 'done', isProfessional: request.isProfessional },
      });
      return view(tx);
    },

    async fastPath(tx, { actor, request }) {
      const created = {
        professional: false,
        location: false,
        hours: false,
        appointmentType: false,
      };

      let own = await ownProfessional(tx, actor.membershipId);
      if (!own) {
        await makeOwnerProfessional(tx, actor, {
          isProfessional: true,
          fullName: request.fullName,
          specialties: request.specialties,
          // The fast path never asks for the matricula: it stays a checklist item.
          matricula: null,
        });
        own = await ownProfessional(tx, actor.membershipId);
        created.professional = true;
      }
      if (!own) throw new Error('the fast path did not leave a professional profile');

      const places = await deps.locations.list(
        tx,
        { roles: actor.roles, membershipId: actor.membershipId },
        { includeInactive: false },
      );
      let place = places[0];
      if (!place) {
        place = await deps.locations.create(tx, {
          actor: actor.audit,
          name: request.locationName ?? DEFAULT_LOCATION_NAME,
          timeZone: deps.defaultTimeZone(actor.country),
        });
        created.location = true;
      }

      if ((await deps.hours.get(tx, own.id)).length === 0) {
        await deps.hours.set(tx, {
          actor: actor.audit,
          viewer: { membershipId: actor.membershipId, roles: actor.roles },
          professionalId: own.id,
          request: { hours: defaultWeeklyHours(place.id) },
        });
        created.hours = true;
      }

      const types: AppointmentTypeDto[] = await deps.types.list(tx, { includeInactive: false });
      if (types.length === 0) {
        await deps.types.create(tx, { actor: actor.audit, request: DEFAULT_APPOINTMENT_TYPE });
        created.appointmentType = true;
      }

      const stored = await loadStored(tx);
      const missing = missingPrerequisites(await readFacts(tx), deps.capabilities);
      const finishing = missing.length === 0 && stored.completedAt === null;
      await saveStored(tx, {
        progress: { ...stored.progress, profile: 'done' },
        answers: { ...stored.answers, isProfessional: true, path: 'solo' },
        currentStep: null,
        ...(finishing ? { completed: { at: deps.clock(), by: actor.audit.userId } } : {}),
      });
      await audit(tx, {
        action: 'onboarding.fast_path',
        outcome: 'allow',
        actor: actor.audit,
        resourceType: RESOURCE,
        metadata: created,
      });
      if (finishing) {
        await audit(tx, {
          action: 'onboarding.completed',
          outcome: 'allow',
          actor: actor.audit,
          resourceType: RESOURCE,
        });
      }
      return { state: await view(tx), created, readyToBook: missing.length === 0 };
    },

    async complete(tx, { actor }) {
      const stored = await loadStored(tx);
      if (stored.completedAt !== null) return view(tx);
      const missing = missingPrerequisites(await readFacts(tx), deps.capabilities);
      if (missing.length > 0) throw new AppError('validation_failed', missingErrors(missing));
      await saveStored(tx, {
        currentStep: null,
        completed: { at: deps.clock(), by: actor.audit.userId },
      });
      await audit(tx, {
        action: 'onboarding.completed',
        outcome: 'allow',
        actor: actor.audit,
        resourceType: RESOURCE,
      });
      return view(tx);
    },

    invitationImpact: (tx, roles) => deps.planImpact.preview(tx, { roles }),
  };
}
