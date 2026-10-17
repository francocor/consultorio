import { eq, inArray, sql } from 'drizzle-orm';

import type { PasswordHasher } from '../../../modules/identity/infrastructure/argon2.js';
import { createAnamnesisService } from '../../../modules/patients/application/anamnesis.js';
import { createAssignmentService } from '../../../modules/patients/application/assignments.js';
import { snapshotOf } from '../../../modules/patients/application/mapping.js';
import { createAppointmentTypeService } from '../../../modules/scheduling/application/appointment-types.js';
import { createBlockService } from '../../../modules/scheduling/application/blocks.js';
import { bookAppointment } from '../../../modules/scheduling/application/book-appointment.js';
import { createSchedulingPorts } from '../../../modules/scheduling/application/drizzle-ports.js';
import { createHolidayService } from '../../../modules/scheduling/application/holidays.js';
import { createHoursPeriodService } from '../../../modules/scheduling/application/hours-periods.js';
import { transitionAppointment } from '../../../modules/scheduling/application/lifecycle.js';
import type { BookActor } from '../../../modules/scheduling/application/placement.js';
import { instantAtLocalMinute } from '../../../modules/scheduling/domain/time.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { membershipLocation } from '../../schema/access.js';
import { patientCoverage, payerPlan } from '../../schema/coverage.js';
import { membership, userAccount } from '../../schema/identity.js';
import { patient, patientRepresentative, patientVersion } from '../../schema/patients.js';
import { payer } from '../../schema/platform-catalogs.js';
import { dataProcessingConsent } from '../../schema/privacy.js';
import { professional, professionalHours } from '../../schema/staff.js';
import { location, tenant } from '../../schema/tenant.js';

import { DEMO_ACCOUNTS, DEMO_PASSWORD } from './credentials.js';
import { buildDemoDataset, type DemoPatient, type DemoStaff } from './dataset.js';
import { buildDemoSchedule, type DemoAppointment } from './schedule.js';

/** The seed cannot run: wrong environment, wrong organization, or data already there. */
/** How long the demo's professionals have been in the team, by their profile. */
const DEMO_TEAM_AGE_MS = 90 * 86_400_000;

export class DemoSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoSeedError';
  }
}

export interface DemoSeedDeps {
  withTenant: WithTenant;
  hasher: PasswordHasher;
  keys: TenantKeys;
  /** Key and version of the data-processing consent text, from the country pack. */
  consentText: { textKey: string; version: string };
  clock: () => Date;
  /**
   * The password of each demo account (by key). Defaults to the documented development password;
   * a deployed demo organization passes freshly generated ones on every reset.
   */
  passwordFor?: (accountKey: string) => string;
  /**
   * The sign-in email of each account. Defaults to the documented one. An account is global (one
   * person, many organizations), so a second demo organization in the same database either gets
   * its own addresses here or shares the existing accounts.
   */
  emailFor?: (account: DemoStaff) => string;
  /** `NODE_ENV` of the process. The seed with the public development passwords never runs in production. */
  environment?: string | undefined;
}

export interface SeededCredential {
  key: string;
  label: string;
  email: string;
  password: string;
}

export interface DemoSeedResult {
  credentials: SeededCredential[];
}

const MAJORITY_AGE = 18;

function addYears(isoDate: string, years: number): string {
  const [year, month, day] = isoDate.split('-');
  return `${String(Number(year) + years)}-${month ?? '01'}-${day ?? '01'}`;
}

function actorOf(userId: string, role: AuditActor['actingRole']): AuditActor {
  return { userId, actingRole: role, ip: null, userAgent: 'demo-seed', requestId: null };
}

/**
 * Fills an empty demo organization with the content of `buildDemoDataset`: staff of every role
 * (each with a sign-in), locations, professionals with weekly hours, payer plans, patients with
 * coverage, consent and representatives, the Aillu look, and an audit trail of how it got there.
 *
 * Accounts are created one transaction each, because the identity policies only let a transaction
 * insert the account it acts as. It refuses an organization that is not flagged as a demo one,
 * one that already has people in it, and any production environment.
 */
export async function seedDemoTenant(
  deps: DemoSeedDeps,
  tenantId: string,
): Promise<DemoSeedResult> {
  // The documented password is public: with it, the seed never runs in production. A deployed
  // demo passes freshly generated passwords for every account (see `resetDemoTenant`).
  if (deps.environment === 'production' && !deps.passwordFor) {
    throw new DemoSeedError('The demo seed never runs in production with the public password.');
  }
  const data = buildDemoDataset();
  const now = deps.clock();
  const system = { tenantId, userId: SYSTEM_USER_ID };

  const state = await deps.withTenant(system, async (tx) => {
    const [row] = await tx
      .select({ isDemo: tenant.isDemo })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    const [existing] = await tx.select({ id: membership.id }).from(membership).limit(1);
    return { isDemo: row?.isDemo ?? false, hasPeople: existing !== undefined };
  });
  if (!state.isDemo) {
    throw new DemoSeedError('The organization is not flagged as a demo organization.');
  }
  if (state.hasPeople) {
    throw new DemoSeedError('The demo organization already has data: reset it before seeding.');
  }

  await deps.withTenant(system, (tx) => deps.keys.ensureTenantKey(tx));

  // 1. Accounts and memberships (one transaction per account).
  const passwords = deps.passwordFor ?? (() => DEMO_PASSWORD);
  const people = new Map<string, { userId: string; membershipId: string; staff: DemoStaff }>();
  const credentials: SeededCredential[] = [];
  for (const staff of data.staff) {
    const email = deps.emailFor ? deps.emailFor(staff) : staff.email;
    const password = passwords(staff.key);
    const passwordHash = await deps.hasher.hash(password);
    const membershipId = uuidv7();
    const known = await deps.withTenant(system, async (tx) => {
      const result = await tx.execute<{ id: string }>(
        sql`select id from app.lookup_user_for_login(${email})`,
      );
      return result.rows[0]?.id;
    });
    const userId = known ?? uuidv7();
    await deps.withTenant({ tenantId, userId }, async (tx) => {
      if (known) {
        // The same person already exists (an earlier seed of another demo organization, or a
        // reset): the account is linked and starts from a clean state with the new password.
        await tx
          .update(userAccount)
          .set({
            passwordHash,
            passwordChangedAt: now,
            totpSecretEnc: null,
            totpPendingEnc: null,
            totpTenantId: null,
            totpConfirmedAt: null,
            totpLastStep: null,
            firstSignInAt: null,
            failedLogins: 0,
            lastFailedAt: null,
            lockedUntil: null,
          })
          .where(eq(userAccount.id, userId));
      } else {
        await tx.insert(userAccount).values({
          id: userId,
          email,
          passwordHash,
          passwordChangedAt: now,
        });
      }
      await tx.insert(membership).values({
        id: membershipId,
        tenantId,
        userId,
        roles: [...staff.roles],
        displayName: staff.displayName,
      });
    });
    people.set(staff.key, { userId, membershipId, staff });
    const account = DEMO_ACCOUNTS.find((candidate) => candidate.key === staff.key);
    credentials.push({ key: staff.key, label: account?.label ?? staff.key, email, password });
  }

  const owner = people.get('owner');
  const reception = people.get('reception');
  if (!owner || !reception)
    throw new DemoSeedError('The dataset needs an owner and a reception user.');
  const ownerActor = actorOf(owner.userId, 'owner');
  const receptionActor = actorOf(reception.userId, 'reception');

  // 2. The organization's content, as the owner.
  const professionalIds = new Map<string, string>();
  const locationIds = new Map<string, string>();
  await deps.withTenant({ tenantId, userId: owner.userId }, async (tx) => {
    await tx
      .update(tenant)
      .set({
        theme: {
          displayName: data.branding.displayName,
          shortName: data.branding.shortName,
          primaryRequested: data.branding.primaryColor,
          radius: data.branding.radius,
          headingFont: data.branding.headingFont,
        },
        billingExempt: true,
      })
      .where(eq(tenant.id, tenantId));
    await audit(tx, {
      action: 'branding.updated',
      outcome: 'allow',
      actor: ownerActor,
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { fields: ['displayName', 'shortName', 'primaryColor', 'radius', 'headingFont'] },
    });

    for (const place of data.locations) {
      const id = uuidv7();
      locationIds.set(place.key, id);
      await tx.insert(location).values({
        id,
        tenantId,
        name: place.name,
        timeZone: place.timeZone,
      });
      await audit(tx, {
        action: 'location.created',
        outcome: 'allow',
        actor: ownerActor,
        resourceType: 'location',
        resourceId: id,
      });
    }

    for (const person of people.values()) {
      const { staff, membershipId } = person;
      for (const key of staff.locations) {
        const locationId = locationIds.get(key);
        if (!locationId) continue;
        await tx.insert(membershipLocation).values({ tenantId, membershipId, locationId });
      }
      await audit(tx, {
        action: 'staff.invited',
        outcome: 'allow',
        actor: ownerActor,
        resourceType: 'membership',
        resourceId: membershipId,
        metadata: { roles: [...staff.roles] },
      });
      if (!staff.professional) continue;
      const professionalId = uuidv7();
      professionalIds.set(staff.key, professionalId);
      await tx.insert(professional).values({
        id: professionalId,
        tenantId,
        membershipId,
        specialties: [...staff.professional.specialties],
        matricula: staff.professional.matricula,
        matriculaJurisdiction: staff.professional.jurisdiction,
        // The demo team has been working there for months: the review flag for a professional added
        // in the last 7 days (decision D19) must not fire on every assignment of the story.
        createdAt: new Date(now.getTime() - DEMO_TEAM_AGE_MS),
      });
      for (const slot of staff.professional.hours) {
        const locationId = locationIds.get(slot.location);
        if (!locationId) continue;
        await tx.insert(professionalHours).values({
          tenantId,
          professionalId,
          locationId,
          weekday: slot.weekday,
          startMinute: slot.startMinute,
          endMinute: slot.endMinute,
        });
      }
      await audit(tx, {
        action: 'professional.hours_updated',
        outcome: 'allow',
        actor: ownerActor,
        resourceType: 'professional',
        resourceId: professionalId,
      });
    }
  });

  // 3. Patients, coverage, consent and representatives, as reception.
  const patientIds: string[] = [];
  await deps.withTenant({ tenantId, userId: reception.userId }, async (tx) => {
    const payerIds = await payerIdsByCode(
      tx,
      data.payerPlans.map((plan) => plan.payerCode),
    );
    const planIds = new Map<string, string>();
    for (const plan of data.payerPlans) {
      const payerId = payerIds.get(plan.payerCode);
      if (!payerId) throw new DemoSeedError(`The payer catalog has no "${plan.payerCode}".`);
      const id = uuidv7();
      planIds.set(`${plan.payerCode}:${plan.planName}`, id);
      await tx.insert(payerPlan).values({ id, tenantId, payerId, planName: plan.planName });
    }
    for (const entry of data.patients) {
      const id = await insertPatient(tx, {
        tenantId,
        entry,
        planIds,
        consentText: deps.consentText,
        now,
        recordedBy: reception.userId,
        actor: receptionActor,
      });
      patientIds.push(id);
    }
  });

  // 4. Who looks after whom, and what the professionals recorded: reception assigns, the assigned
  // professional writes the anamnesis (which is what raises the safety alerts).
  const assignments = createAssignmentService();
  const anamneses = createAnamnesisService({ keys: deps.keys });
  for (const entry of data.care) {
    const patientId = patientIds[entry.patientIndex];
    const professionalId = professionalIds.get(entry.professional);
    const person = people.get(entry.professional);
    if (!patientId || !professionalId || !person) {
      throw new DemoSeedError(
        'A care entry points at a patient or professional that is not there.',
      );
    }
    await deps.withTenant({ tenantId, userId: reception.userId }, (tx) =>
      assignments.assign(tx, {
        actor: { ...receptionActor, userId: reception.userId },
        actorRoles: ['reception'],
        patientId,
        professionalId,
      }),
    );
    if (!entry.anamnesis) continue;
    const content = entry.anamnesis;
    await deps.withTenant(
      { tenantId, userId: person.userId, actingProfessionalId: professionalId },
      (tx) =>
        anamneses.save(tx, {
          actor: { ...actorOf(person.userId, 'professional'), userId: person.userId },
          professionalId,
          patientId,
          content,
          expectedVersion: 0,
        }),
    );
  }

  // 5. The agenda: types, a block, a day off, hours for a range of dates, and appointments around
  // today with every status, all through the same use cases the API runs.
  await seedAgenda(deps, {
    tenantId,
    data,
    now,
    owner,
    reception,
    people,
    professionalIds,
    locationIds,
    patientIds,
  });

  return { credentials };
}

interface AgendaPerson {
  userId: string;
  membershipId: string;
}

const TOOLS = [
  'scheduling.book',
  'scheduling.checkin',
  'scheduling.register_past',
  'scheduling.override_hours',
] as const;

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** How long before a visit the demo says it was booked, so a past visit is not a backdated one. */
const BOOKED_AHEAD_MS = 2 * 86_400_000;

async function seedAgenda(
  deps: DemoSeedDeps,
  input: {
    tenantId: string;
    data: ReturnType<typeof buildDemoDataset>;
    now: Date;
    owner: AgendaPerson;
    reception: AgendaPerson;
    people: ReadonlyMap<string, AgendaPerson>;
    professionalIds: ReadonlyMap<string, string>;
    locationIds: ReadonlyMap<string, string>;
    patientIds: readonly string[];
  },
): Promise<void> {
  const { tenantId, data, now, owner, reception } = input;
  const schedule = buildDemoSchedule(data, now);
  const zoneOf = (locationKey: string) =>
    data.locations.find((place) => place.key === locationKey)?.timeZone ??
    'America/Argentina/Buenos_Aires';
  const ownerActor = { ...actorOf(owner.userId, 'owner'), userId: owner.userId };

  // Setup, as the owner.
  const typeIds = new Map<string, string>();
  await deps.withTenant({ tenantId, userId: owner.userId }, async (tx) => {
    const types = createAppointmentTypeService();
    for (const type of schedule.types) {
      const created = await types.create(tx, {
        actor: ownerActor,
        request: {
          name: type.name,
          durationMinutes: type.durationMinutes,
          bufferMinutes: type.bufferMinutes,
          mode: 'in_person',
          requiresApproval: false,
          color: type.color,
          professionalIds: [],
          specialties: [],
        },
      });
      typeIds.set(type.key, created.id);
    }

    await createHolidayService().createDayOff(tx, {
      actor: ownerActor,
      request: { day: schedule.dayOff.date, name: schedule.dayOff.name },
    });

    const blockedProfessional = input.professionalIds.get(schedule.block.professional);
    const blockedLocation = input.locationIds.get(schedule.block.location);
    if (blockedProfessional && blockedLocation) {
      const zone = zoneOf(schedule.block.location);
      await createBlockService().create(tx, {
        actor: ownerActor,
        request: {
          professionalId: blockedProfessional,
          locationId: blockedLocation,
          startsAt: instantAtLocalMinute(
            zone,
            schedule.block.date,
            schedule.block.startMinute,
          ).toISOString(),
          endsAt: instantAtLocalMinute(
            zone,
            schedule.block.date,
            schedule.block.endMinute,
          ).toISOString(),
          reason: schedule.block.reason,
        },
      });
    }

    const periodProfessional = input.professionalIds.get(schedule.period.professional);
    if (periodProfessional) {
      await createHoursPeriodService().set(tx, {
        actor: ownerActor,
        viewer: { membershipId: owner.membershipId, roles: ['owner'] },
        professionalId: periodProfessional,
        request: {
          dateFrom: schedule.period.dateFrom,
          dateTo: schedule.period.dateTo,
          reason: schedule.period.reason,
          hours: schedule.period.hours.flatMap((slot) => {
            const locationId = input.locationIds.get(slot.location);
            return locationId
              ? [
                  {
                    locationId,
                    weekday: slot.weekday,
                    start: clock(slot.startMinute),
                    end: clock(slot.endMinute),
                  },
                ]
              : [];
          }),
        },
      });
    }
  });

  // Appointments. Holidays are left empty, as in real life.
  const dates = schedule.appointments.map((entry) => entry.date).sort();
  const closed = new Set<string>();
  if (dates.length > 0) {
    const holidays = await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
      createHolidayService().holidaysBetween(tx, dates[0] ?? '', dates.at(-1) ?? ''),
    );
    for (const holiday of holidays) if (holiday.locationId === null) closed.add(holiday.day);
  }

  const actorOfPerson = (
    person: AgendaPerson,
    role: AuditActor['actingRole'],
    professionalId: string | null,
  ): { book: BookActor; audit: AuditActor & { userId: string } } => ({
    book: { userId: person.userId, permissions: new Set(TOOLS), professionalId },
    audit: { ...actorOf(person.userId, role), userId: person.userId },
  });

  const ordered = [...schedule.appointments].sort(
    (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute,
  );
  for (const entry of ordered) {
    if (closed.has(entry.date)) continue;
    const professionalId = input.professionalIds.get(entry.professional);
    const professionalPerson = input.people.get(entry.professional);
    const locationId = input.locationIds.get(entry.location);
    const typeId = typeIds.get(entry.type);
    const patientId = input.patientIds[entry.patientIndex];
    if (!professionalId || !professionalPerson || !locationId || !typeId || !patientId) {
      throw new DemoSeedError('The agenda points at something that is not there.');
    }
    const startMs = instantAtLocalMinute(
      zoneOf(entry.location),
      entry.date,
      entry.startMinute,
    ).getTime();

    // Who takes the booking: reception at its locations, the owner at the others, and the
    // professional themselves for the one booking that shows the identity review.
    const booker = entry.selfBooked
      ? actorOfPerson(professionalPerson, 'professional', professionalId)
      : entry.location === 'cordoba'
        ? actorOfPerson(owner, 'owner', null)
        : actorOfPerson(reception, 'reception', null);
    const front = actorOfPerson(reception, 'reception', null);
    const clinician = actorOfPerson(professionalPerson, 'professional', professionalId);

    await deps.withTenant({ tenantId, userId: booker.book.userId }, async (tx) => {
      const ports = createSchedulingPorts(tx, { keys: deps.keys });
      const booked = await bookAppointment(ports, {
        request: {
          patientId,
          professionalId,
          locationId,
          appointmentTypeId: typeId,
          startsAt: new Date(startMs).toISOString(),
        },
        actor: booker.book,
        auditActor: booker.audit,
        // Booked a couple of days ahead of the visit, never backdated.
        now: new Date(Math.min(now.getTime(), startMs - BOOKED_AHEAD_MS)),
      });
      const move = (
        action: 'confirm' | 'check_in' | 'start' | 'attend' | 'no_show' | 'cancel',
        who: typeof front,
      ) =>
        transitionAppointment(ports, {
          appointmentId: booked.id,
          action,
          actor: who.book,
          auditActor: who.audit,
          now,
          ...(action === 'cancel'
            ? {
                cancellation: {
                  cancelledBy: 'patient' as const,
                  reasonCode: 'patient_request' as const,
                },
              }
            : {}),
        });
      await followTheDay(entry, move, front, clinician);
    });
  }
}

/** Carries an appointment from `scheduled` to the status the demo wants it in. */
async function followTheDay<Who>(
  entry: DemoAppointment,
  move: (
    action: 'confirm' | 'check_in' | 'start' | 'attend' | 'no_show' | 'cancel',
    who: Who,
  ) => Promise<unknown>,
  front: Who,
  clinician: Who,
): Promise<void> {
  switch (entry.status) {
    case 'scheduled':
      return;
    case 'confirmed':
      await move('confirm', front);
      return;
    case 'checked_in':
      await move('check_in', front);
      return;
    case 'in_progress':
      await move('check_in', front);
      await move('start', clinician);
      return;
    case 'attended':
      await move('check_in', front);
      await move('start', clinician);
      await move('attend', clinician);
      return;
    case 'no_show':
      await move('no_show', front);
      return;
    case 'cancelled':
      await move('cancel', front);
      return;
  }
}

async function payerIdsByCode(tx: Tx, codes: readonly string[]): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: payer.id, code: payer.code })
    .from(payer)
    .where(inArray(payer.code, [...new Set(codes)]));
  return new Map(rows.map((row) => [row.code, row.id]));
}

async function insertPatient(
  tx: Tx,
  input: {
    tenantId: string;
    entry: DemoPatient;
    planIds: Map<string, string>;
    consentText: { textKey: string; version: string };
    now: Date;
    recordedBy: string;
    actor: AuditActor;
  },
): Promise<string> {
  const { tenantId, entry, now } = input;
  const id = uuidv7();
  const [row] = await tx
    .insert(patient)
    .values({
      id,
      tenantId,
      familyName: entry.familyName,
      givenNames: entry.givenNames,
      birthDate: entry.birthDate,
      sex: entry.sex,
      nationalIdType: entry.document?.type ?? null,
      nationalId: entry.document?.number ?? null,
      phone: entry.phone,
      email: entry.email,
      address: entry.address,
    })
    .returning();
  if (!row) throw new DemoSeedError('A patient could not be created.');

  await tx.insert(patientVersion).values({
    tenantId,
    patientId: id,
    version: row.version,
    changedBy: input.recordedBy,
    changedFields: [],
    snapshot: snapshotOf(row),
  });
  await audit(tx, {
    action: 'patient.created',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'patient',
    resourceId: id,
    patientId: id,
  });

  if (entry.consent) {
    await tx.insert(dataProcessingConsent).values({
      tenantId,
      patientId: id,
      textKey: input.consentText.textKey,
      textVersion: input.consentText.version,
      grantedAt: now,
      recordedBy: input.recordedBy,
    });
    await audit(tx, {
      action: 'patient.consent.recorded',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'patient',
      resourceId: id,
      patientId: id,
    });
  }

  if (entry.coverage) {
    const payerPlanId = input.planIds.get(`${entry.coverage.payerCode}:${entry.coverage.planName}`);
    if (!payerPlanId) throw new DemoSeedError('A coverage points at a plan that does not exist.');
    await tx.insert(patientCoverage).values({
      tenantId,
      patientId: id,
      payerPlanId,
      memberNumber: entry.coverage.memberNumber,
      isPrimary: true,
    });
    await audit(tx, {
      action: 'patient.coverage.changed',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'patient',
      resourceId: id,
      patientId: id,
    });
  }

  if (entry.representative) {
    await tx.insert(patientRepresentative).values({
      tenantId,
      patientId: id,
      fullName: entry.representative.fullName,
      relation: entry.representative.relation,
      phone: entry.representative.phone,
      email: entry.representative.email,
      majorityReviewOn: addYears(entry.birthDate, MAJORITY_AGE),
    });
    await audit(tx, {
      action: 'patient.representative.changed',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'patient',
      resourceId: id,
      patientId: id,
    });
  }
  return id;
}
