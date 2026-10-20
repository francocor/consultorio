/**
 * Public API of the onboarding module: the guided first run of a new organization (tenant-onboarding,
 * Part A). It keeps the progress of the setup wizard, runs the solo fast path, computes the
 * first-run checklist from the organization's real data and tells the sign-in whether the owner must
 * run the wizard. Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { LocationService } from '../access/index.js';
import type { AppointmentTypeService } from '../scheduling/index.js';
import type { HoursService, OwnerProfessionalService } from '../staff/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportOnboarding } from './application/export-contributor.js';
import {
  createOnboardingService,
  noPlanImpact,
  type PlanImpact,
} from './application/onboarding.js';
import { DEFAULT_CAPABILITIES, type Capabilities } from './domain/capabilities.js';
import { onboardingRoutes } from './http/onboarding-routes.js';

/** Registers what onboarding contributes to the cancellation export. */
export function registerOnboardingExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'onboarding', exportOnboarding);
}

export { createSignup } from './signup/signup.js';
export type { Signup, SignupOptions } from './signup/signup.js';
export { createWizardGate } from './application/wizard-gate.js';
export type { WizardGate } from './application/wizard-gate.js';
export { DEFAULT_CAPABILITIES } from './domain/capabilities.js';
export type { Capabilities, Capability } from './domain/capabilities.js';
export { noPlanImpact } from './application/onboarding.js';
export type { PlanImpact } from './application/onboarding.js';

export interface OnboardingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** The parts of the product this deployment has; steps and items of the others are not shown. */
  capabilities?: Capabilities;
  /** The services the wizard uses to create what it sets up, from the modules that own them. */
  locations: LocationService;
  hours: HoursService;
  ownerProfessional: OwnerProfessionalService;
  types: AppointmentTypeService;
  /** Time zone of a new location, from the country pack of the organization. */
  defaultTimeZone: (country: string) => string;
  /** What inviting someone changes in the plan; nothing until subscriptions exist. */
  planImpact?: PlanImpact;
  clock?: () => Date;
}

export interface Onboarding {
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createOnboarding(options: OnboardingOptions): Onboarding {
  const onboarding = createOnboardingService({
    capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
    locations: options.locations,
    hours: options.hours,
    ownerProfessional: options.ownerProfessional,
    types: options.types,
    defaultTimeZone: options.defaultTimeZone,
    planImpact: options.planImpact ?? noPlanImpact,
    clock: options.clock ?? (() => new Date()),
  });
  return {
    routes: onboardingRoutes({
      withTenant: options.withTenant,
      auditDeny: options.auditDeny,
      onboarding,
    }),
  };
}
