import { DateTime } from 'luxon';

/**
 * What a message about an appointment may be written from (spec "Message content and privacy").
 * Every field is administrative. There is no diagnosis, treatment, note, result or attachment here
 * by design: a message cannot print what it is not given, and the type does not accept more (the
 * render test pins that with `@ts-expect-error`).
 */
export interface AppointmentFacts {
  /** From the branding of the organization, never a literal in a template. */
  organizationName: string;
  /** The patient's given names; the message greets with the first one only. */
  patientGivenNames: string;
  startsAt: Date;
  /** IANA zone of the location: the date and the time are read in it. */
  timeZone: string;
  locationName: string;
  /** Null when the organization hides it, or when there is none to name. */
  professionalName: string | null;
  /** Null when the organization hides it. */
  appointmentTypeName: string | null;
  /** A waitlist offer only: when the offer stops being open. */
  offerExpiresAt?: Date;
}

/**
 * What a message says about the video call of a virtual appointment. The address is the platform
 * join address (never the provider's room); `pending` says the link will be sent separately.
 */
export type VideoNote = { kind: 'link'; url: string } | { kind: 'pending' };

/** The organization's neutral-wording switches (`settings.notifications`). */
export interface Wording {
  hideProfessional: boolean;
  hideAppointmentType: boolean;
}

/** The words that go into a template. Optional parts are absent, not empty. */
export interface MessageVars {
  name: string;
  organization: string;
  date: string;
  time: string;
  place: string;
  professional?: string;
  type?: string;
  /** A waitlist offer only: the time the offer closes, read in the zone of the location. */
  offerExpires?: string;
}

const LOCALE = 'es-AR';

/** The first of the given names: "María Laura" is greeted as "María". */
export function firstNameOf(givenNames: string): string {
  return givenNames.trim().split(/\s+/)[0] ?? '';
}

/** "lunes 12 de mayo", read in the zone of the location. */
export function formatDate(instant: Date, timeZone: string): string {
  return DateTime.fromJSDate(instant, { zone: timeZone })
    .setLocale(LOCALE)
    .toFormat("cccc d 'de' LLLL");
}

/** "10:00", 24-hour, read in the zone of the location. */
export function formatTime(instant: Date, timeZone: string): string {
  return DateTime.fromJSDate(instant, { zone: timeZone }).setLocale(LOCALE).toFormat('HH:mm');
}

/**
 * The variables of a message: first name, date, time, place and, unless the organization hides
 * them, the professional and the type of appointment. Fields are copied one by one, so anything
 * else that reaches the facts at run time is not printed.
 */
export function describeAppointment(facts: AppointmentFacts, wording: Wording): MessageVars {
  const vars: MessageVars = {
    name: firstNameOf(facts.patientGivenNames),
    organization: facts.organizationName,
    date: formatDate(facts.startsAt, facts.timeZone),
    time: formatTime(facts.startsAt, facts.timeZone),
    place: facts.locationName,
  };
  if (!wording.hideProfessional && facts.professionalName !== null) {
    vars.professional = facts.professionalName;
  }
  if (!wording.hideAppointmentType && facts.appointmentTypeName !== null) {
    vars.type = facts.appointmentTypeName;
  }
  if (facts.offerExpiresAt !== undefined) {
    vars.offerExpires = formatTime(facts.offerExpiresAt, facts.timeZone);
  }
  return vars;
}
