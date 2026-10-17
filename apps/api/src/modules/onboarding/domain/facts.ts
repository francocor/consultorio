/**
 * What the organization actually has, counted from its own data. The checklist and the wizard read
 * this instead of remembering clicks, so an item completes the moment the work is done wherever it
 * was done (the wizard, a settings screen, an invitation accepted by someone else).
 */
export interface OnboardingFacts {
  /** Active locations. */
  locations: number;
  /** Active professionals, with or without a registration. */
  professionals: number;
  /** Active professionals with working hours at an active location. */
  professionalsWithHours: number;
  /** Active appointment types. */
  appointmentTypes: number;
  patients: number;
  /** Appointments in any status. */
  appointments: number;
  /** Active professionals whose matricula is recorded (verified or not). */
  professionalsWithMatricula: number;
  /** Someone besides the owner was invited or has joined. */
  staffInvited: boolean;
  /** The organization saved its own identity (colors or logo), beyond its name. */
  brandingConfigured: boolean;
}
