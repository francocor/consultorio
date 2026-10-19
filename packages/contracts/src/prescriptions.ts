import { z } from 'zod';

export { PRESCRIPTION_ERRORS, PRESCRIPTION_AUDIT_ACTIONS } from './prescriptions-catalog.js';

/**
 * Contracts of the prescriptions module (e-prescription under Ley 27.553). The provider port is
 * `PrescriptionProvider` in `ports.ts`; the request and response shapes of the module are here.
 */

/**
 * Where a prescription stands. `pending_submission` is a prescription the provider has not
 * confirmed (an outage): it is never shown as a valid prescription. `draft` is a prescription the
 * provider refused: it keeps its lines and the reason, and can be corrected and sent again.
 */
export const PRESCRIPTION_STATUSES = [
  'draft',
  'pending_submission',
  'issued',
  'cancelled',
  'dispensed',
  'expired',
] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

/**
 * The modes the local e-prescription provider (a simulator) can be put in from the provider
 * console: working, down, or having issued the prescription and then lost the answer.
 */
export const ERX_SIMULATOR_MODES = ['ok', 'down', 'timeout_after_issue'] as const;
export type ErxSimulatorMode = (typeof ERX_SIMULATOR_MODES)[number];

/** The most medications one prescription carries. */
export const MAX_PRESCRIPTION_ITEMS = 10;

const Text = (max: number) => z.string().trim().min(1).max(max);

/** One medication, by its generic name (international nonproprietary name). */
export const PrescriptionItem = z.strictObject({
  genericName: Text(120),
  dose: Text(60),
  form: Text(60),
  /** Units to dispense. */
  quantity: z.int().min(1).max(999),
  instructions: Text(300),
});
export type PrescriptionItem = z.infer<typeof PrescriptionItem>;

const Items = z.array(PrescriptionItem).min(1).max(MAX_PRESCRIPTION_ITEMS);

/**
 * Issues a prescription. The client key is made by the form for each submission, so pressing the
 * button twice cannot produce two prescriptions. The patient, the prescriber, the date and the
 * coverage are never sent: the server takes them from the records.
 */
export const IssuePrescriptionRequest = z.strictObject({
  clientKey: z.uuid(),
  patientId: z.uuid(),
  encounterId: z.uuid().optional(),
  items: Items,
});
export type IssuePrescriptionRequest = z.infer<typeof IssuePrescriptionRequest>;

/** Corrects a prescription the provider refused and sends it again. */
export const CorrectPrescriptionRequest = z.strictObject({ items: Items });
export type CorrectPrescriptionRequest = z.infer<typeof CorrectPrescriptionRequest>;

export const CancelPrescriptionRequest = z.strictObject({
  reason: Text(300),
  /**
   * The professional knows that the provider may hold this prescription and that no provider is
   * connected to ask (JD-S5 R2, B-T7): the prescription is closed here without asking, and the trail
   * says so. Without it, a prescription the provider may hold is closed only after the provider was
   * asked, and it is never closed this way while a provider is connected.
   */
  acknowledgeUnknownOutcome: z.boolean().optional(),
});
export type CancelPrescriptionRequest = z.infer<typeof CancelPrescriptionRequest>;

/**
 * The shape of an identifier a provider gives: letters and digits, with dots, slashes, hyphens and
 * underscores inside, 4 to 80 characters, no spaces. It ends on a document that a pharmacy reads, so
 * a free text is not accepted (JD-S5 R1-A-T5).
 */
export const PRESCRIPTION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{3,79}$/;

/** The identifier the professional got by issuing the prescription on the provider's own site. */
export const RegisterManualPrescriptionRequest = z.strictObject({
  identifier: Text(80).regex(PRESCRIPTION_IDENTIFIER_PATTERN),
});
export type RegisterManualPrescriptionRequest = z.infer<typeof RegisterManualPrescriptionRequest>;

/** Why a prescription that is not issued is not: the provider refused it, or could not be reached. */
export const PRESCRIPTION_FAILURE_KINDS = ['rejected', 'unavailable', 'needs_attention'] as const;
export type PrescriptionFailureKind = (typeof PRESCRIPTION_FAILURE_KINDS)[number];

export const PrescriptionFailureDto = z.strictObject({
  kind: z.enum(PRESCRIPTION_FAILURE_KINDS),
  /** The words of the provider about a refusal; null for an outage. */
  message: z.string().nullable(),
  attempts: z.int(),
  nextAttemptAt: z.iso.datetime().nullable(),
  /** The provider may have issued it and the answer is not known: it is asked before anything is sent. */
  awaitingReconciliation: z.boolean(),
});
export type PrescriptionFailureDto = z.infer<typeof PrescriptionFailureDto>;

/** A prescription as the professionals who may read it see it. */
export const PrescriptionDto = z.strictObject({
  id: z.uuid(),
  patientId: z.uuid(),
  encounterId: z.uuid().nullable(),
  status: z.enum(PRESCRIPTION_STATUSES),
  /** The date printed on the prescription. */
  date: z.iso.date(),
  createdAt: z.iso.datetime(),
  issuedAt: z.iso.datetime().nullable(),
  /** The identifier the provider gave it. */
  externalId: z.string().nullable(),
  registeredManually: z.boolean(),
  prescriber: z.strictObject({
    professionalId: z.uuid(),
    fullName: z.string(),
    matricula: z.string(),
    jurisdiction: z.string(),
    specialty: z.string().nullable(),
  }),
  patient: z.strictObject({
    fullName: z.string(),
    documentType: z.string().nullable(),
    documentNumber: z.string().nullable(),
    coverage: z.strictObject({ payerName: z.string(), planName: z.string().nullable() }).nullable(),
  }),
  items: z.array(PrescriptionItem),
  cancelReason: z.string().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  failure: PrescriptionFailureDto.nullable(),
  /** A simulator is behind it: the document has no legal validity. */
  simulated: z.boolean(),
  /** The document can be downloaded. */
  documentAvailable: z.boolean(),
});
export type PrescriptionDto = z.infer<typeof PrescriptionDto>;

export const PrescriptionListResponse = z.strictObject({ prescriptions: z.array(PrescriptionDto) });
export type PrescriptionListResponse = z.infer<typeof PrescriptionListResponse>;

/**
 * What reception sees when the organization lets it: that a prescription exists, when, and where it
 * stands. Never a medication, a prescriber or a patient name.
 */
export const PrescriptionExistenceDto = z.strictObject({
  id: z.uuid(),
  status: z.enum(PRESCRIPTION_STATUSES),
  createdAt: z.iso.datetime(),
});
export type PrescriptionExistenceDto = z.infer<typeof PrescriptionExistenceDto>;

export const PrescriptionExistenceResponse = z.strictObject({
  /** False when the organization did not turn the setting on: there is nothing to show. */
  visible: z.boolean(),
  prescriptions: z.array(PrescriptionExistenceDto),
});
export type PrescriptionExistenceResponse = z.infer<typeof PrescriptionExistenceResponse>;

/** What the screen needs to decide whether the form of a prescription is available. */
export const PrescriptionCapabilityDto = z.strictObject({
  /** The deployment serves a provider for this organization. */
  providerAvailable: z.boolean(),
  /** The professional the answer is about: the screen compares it with the prescriber of each prescription. */
  professionalId: z.uuid(),
  /** The owner or an admin switched e-prescription on for the organization. */
  enabled: z.boolean(),
  /** The provider is a simulator. */
  simulated: z.boolean(),
  /** The matricula of the professional, as the platform operator left it. */
  matriculaStatus: z.enum(['verified', 'unverified', 'missing']),
  /** Everything is in place for this professional to issue. */
  canIssue: z.boolean(),
});
export type PrescriptionCapabilityDto = z.infer<typeof PrescriptionCapabilityDto>;

/** The connection of the organization to the provider. Credentials are never returned. */
export const ErxConnectionDto = z.strictObject({
  providerAvailable: z.boolean(),
  provider: z.string().nullable(),
  enabled: z.boolean(),
  simulated: z.boolean(),
  credentialsSaved: z.boolean(),
});
export type ErxConnectionDto = z.infer<typeof ErxConnectionDto>;

export const PutErxConnectionRequest = z.strictObject({
  enabled: z.boolean(),
  /** Written once and never shown again; the simulator needs none. */
  credentials: z.string().min(1).max(4000).optional(),
});
export type PutErxConnectionRequest = z.infer<typeof PutErxConnectionRequest>;

/** The generic names that start with what is typed. */
export const GenericNameSearchResponse = z.strictObject({ names: z.array(z.string()) });
export type GenericNameSearchResponse = z.infer<typeof GenericNameSearchResponse>;

/** What the patient portal lists of a prescription: no medication unless the portal says so. */
export const PortalPrescriptionListing = z.strictObject({
  id: z.uuid(),
  issuedAt: z.iso.datetime(),
  status: z.enum(['issued', 'cancelled', 'dispensed', 'expired']),
  /** Whether a document can be downloaded now: kept, or made on request. */
  hasDocument: z.boolean(),
});
export type PortalPrescriptionListing = z.infer<typeof PortalPrescriptionListing>;

// Provider console: the e-prescription simulator (S5.04) -----------------------------------------

export const ErxSimulatorModeRequest = z.strictObject({ mode: z.enum(ERX_SIMULATOR_MODES) });
export type ErxSimulatorModeRequest = z.infer<typeof ErxSimulatorModeRequest>;

/** A prescription the simulator issued, as the console lists it (no medication, no patient). */
export const ErxSimulatorPrescriptionDto = z.strictObject({
  externalId: z.string(),
  state: z.enum(['issued', 'cancelled', 'dispensed', 'expired']),
  createdAt: z.iso.datetime(),
});
export type ErxSimulatorPrescriptionDto = z.infer<typeof ErxSimulatorPrescriptionDto>;

export const ErxSimulatorStateResponse = z.strictObject({
  mode: z.enum(ERX_SIMULATOR_MODES),
  /** The newest first. */
  prescriptions: z.array(ErxSimulatorPrescriptionDto),
});
export type ErxSimulatorStateResponse = z.infer<typeof ErxSimulatorStateResponse>;

/** What a pharmacy or the calendar does to an issued prescription. */
export const ErxSimulatorAdvanceRequest = z.strictObject({
  externalId: z.string().min(1).max(80),
  to: z.enum(['dispensed', 'expired']),
});
export type ErxSimulatorAdvanceRequest = z.infer<typeof ErxSimulatorAdvanceRequest>;

export const ErxSimulatorAdvanceResponse = z.strictObject({
  /** The webhook accepted the notice. */
  delivered: z.boolean(),
});
export type ErxSimulatorAdvanceResponse = z.infer<typeof ErxSimulatorAdvanceResponse>;

/** The notice a provider sends when a prescription changes state; the module asks the provider again. */
export const ErxWebhookEvent = z.object({
  eventId: z.string().min(1).max(100),
  externalId: z.string().min(1).max(80),
  state: z.enum(['issued', 'cancelled', 'dispensed', 'expired']),
});
export type ErxWebhookEvent = z.infer<typeof ErxWebhookEvent>;
