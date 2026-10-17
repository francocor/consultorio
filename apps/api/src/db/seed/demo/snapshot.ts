import { asc, eq } from 'drizzle-orm';

import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { membershipLocation } from '../../schema/access.js';
import { careAssignment } from '../../schema/care.js';
import { addendum, clinicalNote, encounter } from '../../schema/clinical.js';
import { patientCoverage, payerPlan } from '../../schema/coverage.js';
import { document } from '../../schema/documents.js';
import { membership, userAccount } from '../../schema/identity.js';
import { patient, patientRepresentative } from '../../schema/patients.js';
import { payer } from '../../schema/platform-catalogs.js';
import { dataProcessingConsent } from '../../schema/privacy.js';
import { professional, professionalHours } from '../../schema/staff.js';
import { location, tenant } from '../../schema/tenant.js';

/**
 * The logical content of an organization: what a person would notice (names, documents, roles,
 * coverage, hours), without ids, timestamps and password hashes. Two seeds of the same dataset
 * produce equal snapshots; the reset test uses it to prove "identical logical content".
 */
export interface DemoSnapshot {
  theme: Record<string, unknown>;
  locations: { name: string; timeZone: string }[];
  staff: {
    email: string;
    displayName: string | null;
    roles: string[];
    locations: string[];
    specialties: string[];
    matricula: string | null;
    hours: string[];
  }[];
  patients: {
    name: string;
    birthDate: string;
    document: string | null;
    coverage: string | null;
    consent: boolean;
    representative: string | null;
    assignedTo: string[];
    alerts: string[];
  }[];
  /** The clinical notes, as each author sees them (the content itself is encrypted and not compared). */
  notes: {
    author: string;
    specialties: string[];
    patient: string;
    template: string;
    status: string;
    visibility: string;
    addenda: number;
    /** Opened from an appointment of the agenda (decision D20). */
    fromAppointment: boolean;
  }[];
  /** The files of the organization with the verdict of the scan; the bytes are not compared. */
  documents: {
    patient: string;
    name: string;
    category: string;
    classification: string;
    status: string;
    scanResult: string | null;
    linkedTo: string[];
  }[];
}

export async function snapshotDemoTenant(
  withTenant: WithTenant,
  tenantId: string,
): Promise<DemoSnapshot> {
  const staff = await withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
    tx
      .select({
        id: professional.id,
        specialties: professional.specialties,
        name: membership.displayName,
        userId: membership.userId,
      })
      .from(professional)
      .innerJoin(membership, eq(membership.id, professional.membershipId)),
  );
  // Clinical rows are visible only to the professional who wrote them (or treats the patient), so
  // each author's notes are read as that author.
  const notes: DemoSnapshot['notes'] = [];
  for (const author of staff) {
    const rows = await withTenant(
      { tenantId, userId: author.userId, actingProfessionalId: author.id },
      async (tx) => {
        const written = await tx
          .select({
            id: clinicalNote.id,
            status: clinicalNote.status,
            template: clinicalNote.templateKind,
            visibility: clinicalNote.visibility,
            family: patient.familyName,
            given: patient.givenNames,
            appointmentId: encounter.appointmentId,
          })
          .from(clinicalNote)
          .innerJoin(patient, eq(patient.id, clinicalNote.patientId))
          .innerJoin(encounter, eq(encounter.id, clinicalNote.encounterId))
          .where(eq(clinicalNote.authorProfessionalId, author.id));
        const extra = await tx.select({ noteId: addendum.noteId }).from(addendum);
        return written.map((row) => ({
          ...row,
          addenda: extra.filter((entry) => entry.noteId === row.id).length,
        }));
      },
    );
    for (const row of rows) {
      notes.push({
        author: author.name ?? '?',
        specialties: [...author.specialties],
        patient: `${row.family}, ${row.given}`,
        template: row.template,
        status: row.status,
        visibility: row.visibility,
        addenda: row.addenda,
        fromAppointment: row.appointmentId !== null,
      });
    }
  }
  notes.sort((a, b) =>
    `${a.author}|${a.patient}|${a.template}|${a.status}`.localeCompare(
      `${b.author}|${b.patient}|${b.template}|${b.status}`,
    ),
  );

  return withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const [org] = await tx
      .select({ theme: tenant.theme })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    const places = await tx.select().from(location).orderBy(asc(location.name));
    const placeName = new Map(places.map((place) => [place.id, place.name]));

    const members = await tx
      .select({
        id: membership.id,
        displayName: membership.displayName,
        roles: membership.roles,
        email: userAccount.email,
      })
      .from(membership)
      .innerJoin(userAccount, eq(userAccount.id, membership.userId))
      .orderBy(asc(userAccount.email));
    const assignments = await tx.select().from(membershipLocation);
    const profiles = await tx.select().from(professional);
    const slots = await tx.select().from(professionalHours);

    const people = await tx
      .select()
      .from(patient)
      .orderBy(asc(patient.familyName), asc(patient.givenNames));
    const coverages = await tx
      .select({
        patientId: patientCoverage.patientId,
        number: patientCoverage.memberNumber,
        plan: payerPlan.planName,
        payer: payer.name,
      })
      .from(patientCoverage)
      .innerJoin(payerPlan, eq(payerPlan.id, patientCoverage.payerPlanId))
      .innerJoin(payer, eq(payer.id, payerPlan.payerId));
    const consents = await tx
      .select({ patientId: dataProcessingConsent.patientId })
      .from(dataProcessingConsent);
    const guardians = await tx.select().from(patientRepresentative);
    const files = await tx
      .select({
        family: patient.familyName,
        given: patient.givenNames,
        name: document.originalName,
        category: document.category,
        classification: document.classification,
        status: document.status,
        scanResult: document.scanResult,
        encounterId: document.encounterId,
        appointmentId: document.appointmentId,
      })
      .from(document)
      .innerJoin(patient, eq(patient.id, document.patientId))
      .orderBy(asc(patient.familyName), asc(document.originalName));
    const care = await tx
      .select({ patientId: careAssignment.patientId, name: membership.displayName })
      .from(careAssignment)
      .innerJoin(professional, eq(professional.id, careAssignment.professionalId))
      .innerJoin(membership, eq(membership.id, professional.membershipId));

    return {
      theme: org?.theme ?? {},
      locations: places.map((place) => ({ name: place.name, timeZone: place.timeZone })),
      staff: members.map((member) => {
        const profile = profiles.find((candidate) => candidate.membershipId === member.id);
        return {
          email: member.email,
          displayName: member.displayName,
          roles: [...member.roles].sort(),
          locations: assignments
            .filter((entry) => entry.membershipId === member.id)
            .map((entry) => placeName.get(entry.locationId) ?? '?')
            .sort(),
          specialties: profile ? [...profile.specialties] : [],
          matricula: profile
            ? `${profile.matriculaJurisdiction ?? ''} ${profile.matricula ?? ''}`
            : null,
          hours: slots
            .filter((slot) => slot.professionalId === profile?.id)
            .map(
              (slot) =>
                `${placeName.get(slot.locationId) ?? '?'} ${String(slot.weekday)} ${String(slot.startMinute)}-${String(slot.endMinute)}`,
            )
            .sort(),
        };
      }),
      patients: people.map((person) => {
        const coverage = coverages.find((entry) => entry.patientId === person.id);
        const guardian = guardians.find((entry) => entry.patientId === person.id);
        return {
          name: `${person.familyName}, ${person.givenNames}`,
          birthDate: person.birthDate,
          document:
            person.nationalId === null
              ? null
              : `${person.nationalIdType ?? ''} ${person.nationalId}`,
          coverage: coverage
            ? `${coverage.payer} ${coverage.plan ?? ''} ${coverage.number ?? ''}`
            : null,
          consent: consents.some((entry) => entry.patientId === person.id),
          representative: guardian ? `${guardian.fullName} (${guardian.relation})` : null,
          assignedTo: care
            .filter((entry) => entry.patientId === person.id)
            .map((entry) => entry.name ?? '?')
            .sort(),
          alerts: [...person.safetyFlags].sort(),
        };
      }),
      notes,
      documents: files.map((file) => ({
        patient: `${file.family}, ${file.given}`,
        name: file.name,
        category: file.category,
        classification: file.classification,
        status: file.status,
        scanResult: file.scanResult,
        linkedTo: [
          ...(file.encounterId ? ['encounter'] : []),
          ...(file.appointmentId ? ['appointment'] : []),
        ],
      })),
    };
  });
}
