import { eq, inArray, sql } from 'drizzle-orm';

import { createAmendmentService } from '../../../modules/clinical/application/amendments.js';
import { createNoteService, type Caller } from '../../../modules/clinical/application/notes.js';
import type { PasswordHasher } from '../../../modules/identity/infrastructure/argon2.js';
import { createAnamnesisService } from '../../../modules/patients/application/anamnesis.js';
import { createAssignmentService } from '../../../modules/patients/application/assignments.js';
import { snapshotOf } from '../../../modules/patients/application/mapping.js';
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

    const locationIds = new Map<string, string>();
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

  // 5. What the professionals wrote, through the same services the API uses (so the encryption, the
  // signature hash and the audit entries are the real ones): notes signed, a draft left open, an
  // addendum, an entry marked in error and one restricted to its author.
  const notes = createNoteService({ keys: deps.keys });
  const amendments = createAmendmentService({ keys: deps.keys });
  for (const entry of data.notes) {
    const patientId = patientIds[entry.patientIndex];
    const professionalId = professionalIds.get(entry.professional);
    const person = people.get(entry.professional);
    if (!patientId || !professionalId || !person) {
      throw new DemoSeedError('A note points at a patient or professional that is not there.');
    }
    const context = { tenantId, userId: person.userId, actingProfessionalId: professionalId };
    const caller: Caller = {
      actor: { ...actorOf(person.userId, 'professional'), userId: person.userId },
      professionalId,
      tenantActive: true,
    };
    const opened = await deps.withTenant(context, (tx) =>
      notes.open(tx, caller, {
        patientId,
        templateKind: entry.templateKind,
        ...(entry.visibility ? { visibility: entry.visibility } : {}),
      }),
    );
    await deps.withTenant(context, (tx) =>
      notes.saveDraft(tx, caller, {
        encounterId: opened.encounterId,
        request: { content: entry.content, baseRevision: 0 },
      }),
    );
    if (entry.state === 'draft') continue;
    await deps.withTenant(context, (tx) =>
      notes.sign(tx, caller, { noteId: opened.id, expectedRevision: 1 }),
    );
    if (entry.addendum) {
      const addendum = entry.addendum;
      await deps.withTenant(context, (tx) =>
        amendments.addAddendum(tx, caller, { noteId: opened.id, request: addendum }),
      );
    }
    if (entry.state === 'error' && entry.errorReason) {
      const reason = entry.errorReason;
      await deps.withTenant(context, (tx) =>
        amendments.markEnteredInError(tx, caller, { noteId: opened.id, request: { reason } }),
      );
    }
  }

  return { credentials };
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
