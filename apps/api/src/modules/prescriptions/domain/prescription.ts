import { createHash } from 'node:crypto';

import { PrescriptionItem, type PrescriptionRequest } from '@consultorio/contracts';
import { z } from 'zod';

/**
 * What a prescription says (e-prescription, "Prescription content"): the patient (full name,
 * document, coverage when there is one), the prescriber (name, matricula, specialty), the date and
 * the medications by generic name with dose, form, quantity and instructions. It is copied from the
 * records when the prescription is made and stored encrypted, so what was issued never changes with
 * the record of the patient or the profile of the prescriber.
 */
export const PrescriptionContentSchema = z.strictObject({
  patient: z.strictObject({
    fullName: z.string(),
    documentType: z.enum(['dni', 'passport']),
    documentNumber: z.string(),
    coverage: z.strictObject({ payerName: z.string(), planName: z.string().nullable() }).nullable(),
  }),
  prescriber: z.strictObject({
    fullName: z.string(),
    matricula: z.string(),
    jurisdiction: z.string(),
    specialty: z.string().nullable(),
  }),
  /** `YYYY-MM-DD`: the day in the time zone of the practice. */
  date: z.iso.date(),
  items: z.array(PrescriptionItem).min(1),
});
export type PrescriptionContent = z.infer<typeof PrescriptionContentSchema>;

/** The text stored (encrypted) for a prescription. */
export function serializeContent(content: PrescriptionContent): string {
  return JSON.stringify(PrescriptionContentSchema.parse(content));
}

/** The prescription a stored text describes; throws when it is not one. */
export function parseContent(text: string): PrescriptionContent {
  return PrescriptionContentSchema.parse(JSON.parse(text));
}

/**
 * One medication as the provider receives it: the generic name first (a provider that keeps a
 * catalog checks the line against it), then dose, form, quantity and instructions.
 */
export function medicationLine(item: PrescriptionItem): string {
  return `${item.genericName} ${item.dose}, ${item.form}, cantidad ${String(item.quantity)}. ${item.instructions}`;
}

/** What the provider is asked to issue. The content is clinical: it never goes to logs. */
export function providerRequestOf(content: PrescriptionContent): PrescriptionRequest {
  return {
    matricula: {
      jurisdiction: content.prescriber.jurisdiction,
      number: content.prescriber.matricula,
    },
    patientDocument: { type: content.patient.documentType, number: content.patient.documentNumber },
    items: content.items.map(medicationLine),
  };
}

const keyOf = (purpose: string, tenantId: string, prescriptionId: string) =>
  createHash('sha256').update(`${purpose}|${tenantId}|${prescriptionId}`).digest('hex');

/**
 * The key the provider is asked to issue with. It is global (a provider serves many organizations),
 * so it is derived from the organization and the prescription and never taken from the client: the
 * key a form makes is only unique inside one organization.
 */
export function issueKeyOf(tenantId: string, prescriptionId: string): string {
  return keyOf('erx-issue', tenantId, prescriptionId);
}

/** The key a cancellation is sent with: one answer per prescription, however many times it is asked. */
export function cancelKeyOf(tenantId: string, prescriptionId: string): string {
  return keyOf('erx-cancel', tenantId, prescriptionId);
}

/** The day it is in a time zone, as `YYYY-MM-DD`. */
export function documentDate(now: Date, timeZone: string): string {
  // The Canadian English locale writes dates as year-month-day.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const MINUTE_MS = 60_000;
const MAX_DELAY_MS = 60 * MINUTE_MS;

/**
 * How long to wait after the attempt number `attempts` failed: a minute, doubling, up to an hour. A
 * professional is waiting for this prescription, so the wait is shorter than the invoices'.
 */
export function nextAttemptDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 20) - 1);
  return Math.min(MINUTE_MS * 2 ** exponent, MAX_DELAY_MS);
}

const MAX_MESSAGE = 300;

/** The words of the provider about a refusal, cleaned for storing and showing. */
export function cleanProviderMessage(message: string): string {
  // A control character (a line break included) becomes a space; nothing else is touched.
  let printable = '';
  for (const char of message) {
    const code = char.codePointAt(0) ?? 0;
    printable += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  const text = printable.replace(/\s+/g, ' ').trim();
  return (text === '' ? 'El proveedor rechazó la receta.' : text).slice(0, MAX_MESSAGE);
}
