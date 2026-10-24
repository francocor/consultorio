import { eq } from 'drizzle-orm';

import type { AuditActor } from '../../../../platform/audit/writer.js';
import { SYSTEM_USER_ID } from '../../../../platform/db/tenant-context.js';
import { patient } from '../../../schema/patients.js';
import type { DemoContributorContext } from '../contributors.js';

/**
 * Pieces the Stage 5 demo seeds share (consent, prescriptions, portal). Nothing here talks to the
 * outside world: the demonstration organization only gets the fakes, no email is sent (the portal
 * code is read in the provider console, from the demo outbox, when somebody asks for one), and
 * nothing is put on a queue.
 */

export type Stage5Context = DemoContributorContext;

/** The members of the team the story needs, with the professional record of those who have one. */
export interface Stage5Person {
  userId: string;
  membershipId: string;
  /** Present for the professionals. */
  professionalId: string | null;
}

export interface Stage5People {
  owner: Stage5Person;
  reception: Stage5Person;
  cardiology: Stage5Person;
  pediatrics: Stage5Person;
  psychology: Stage5Person;
}

export function peopleOf(context: Stage5Context): Stage5People {
  const person = (key: string): Stage5Person => {
    const found = context.people.get(key);
    if (!found) throw new Error(`The Stage 5 demo seed needs the "${key}" account.`);
    return {
      userId: found.userId,
      membershipId: found.membershipId,
      professionalId: context.professionalIds.get(key) ?? null,
    };
  };
  return {
    owner: person('owner'),
    reception: person('reception'),
    cardiology: person('cardiology'),
    pediatrics: person('pediatrics'),
    psychology: person('psychology'),
  };
}

export function professionalIdOf(person: Stage5Person): string {
  if (person.professionalId === null) {
    throw new Error('The Stage 5 demo seed needs a professional here.');
  }
  return person.professionalId;
}

export function auditActorOf(
  person: Stage5Person,
  role: NonNullable<AuditActor['actingRole']>,
): AuditActor & { userId: string } {
  return {
    userId: person.userId,
    actingRole: role,
    ip: null,
    userAgent: 'demo-seed',
    requestId: null,
  };
}

/** The transaction context of a person: a professional acts as their own professional record. */
export function contextOf(context: Stage5Context, person: Stage5Person) {
  return {
    tenantId: context.tenantId,
    userId: person.userId,
    ...(person.professionalId === null ? {} : { actingProfessionalId: person.professionalId }),
  };
}

export const systemContextOf = (context: Stage5Context) => ({
  tenantId: context.tenantId,
  userId: SYSTEM_USER_ID,
});

/**
 * The patients of the story, found the way a person would: by the identity document of the demo
 * dataset (`99000001` is the first of its list) or, for the newborn who has none, by name.
 */
export const DEMO_PATIENTS = {
  /** Cardiology; has the portal account, the prescription and the consent that waits in the portal. */
  valentina: { document: '99000001' },
  santiago: { document: '99000002' },
  martina: { document: '99000003' },
  joaquin: { document: '99000004' },
  sofia: { document: '99000005' },
  /** Psychology. */
  camila: { document: '99000007' },
  /** Pediatrics; minors with a representative. */
  isabella: { document: '99000023' },
  ian: { name: { family: 'Navarro', given: 'Ian' } },
} as const;

export type DemoPatientKey = keyof typeof DEMO_PATIENTS;

export interface StoryPatient {
  id: string;
  fullName: string;
  email: string | null;
}

/** Looks every patient of the story up in one read. */
export async function findStoryPatients(
  context: Stage5Context,
): Promise<Record<DemoPatientKey, StoryPatient>> {
  const rows = await context.withTenant(systemContextOf(context), (tx) =>
    tx
      .select({
        id: patient.id,
        document: patient.nationalId,
        family: patient.familyName,
        given: patient.givenNames,
        email: patient.email,
      })
      .from(patient)
      .where(eq(patient.status, 'active')),
  );
  const found = {} as Record<DemoPatientKey, StoryPatient>;
  for (const [key, wanted] of Object.entries(DEMO_PATIENTS) as [
    DemoPatientKey,
    (typeof DEMO_PATIENTS)[DemoPatientKey],
  ][]) {
    const row = rows.find((candidate) =>
      'document' in wanted
        ? candidate.document === wanted.document
        : candidate.family === wanted.name.family && candidate.given === wanted.name.given,
    );
    if (!row) throw new Error(`The Stage 5 demo seed did not find the patient "${key}".`);
    found[key] = {
      id: row.id,
      fullName: `${row.given} ${row.family}`,
      email: row.email,
    };
  }
  return found;
}
