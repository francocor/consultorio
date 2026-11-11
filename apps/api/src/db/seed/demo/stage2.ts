import type { CreateUploadsRequest, Role } from '@consultorio/contracts';

import type { FakePrescriptionProvider } from '../../../adapters/erx-fake/index.js';
import { createAmendmentService } from '../../../modules/clinical/application/amendments.js';
import { createNoteService, type Caller } from '../../../modules/clinical/application/notes.js';
import { createScanJob } from '../../../modules/documents/application/scan-job.js';
import { createUploadService, SCAN_JOB } from '../../../modules/documents/application/uploads.js';
import { findCareSourceAppointment } from '../../../modules/scheduling/application/care-source.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { Db } from '../../../platform/db/pool.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { EICAR, minimalJpeg, minimalPdf, minimalPng } from '../../../platform/files/test-files.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { MalwareScanner } from '../../../platform/scanning/malware-scanner.js';
import { tenantKey, type ObjectStorage } from '../../../platform/storage/object-storage.js';

import type { DemoAppointment, DemoProfessionalKey } from './schedule.js';

/**
 * The Stage 2 part of the demo: what a believable day leaves behind once the agenda, the clinical
 * record and the documents all exist (tasks 2.94). Everything goes through the same services the
 * API runs, so the encryption, the signature hash, the scan and the audit entries are the real ones.
 *
 * - **Consultations from appointments.** The professionals of the day opened an encounter from the
 *   appointment (decision D20), wrote the note and signed it; one visit is still in progress and its
 *   note is a draft; one signed note carries an addendum.
 * - **Documents.** Reception scanned identity cards and signed forms; the professionals attached a
 *   lab result, an image and a referral to a visit. Every file went through the (fake) malware
 *   scanner; one refused file shows what a rejection looks like.
 */

export interface DemoDocumentsDeps {
  storage: ObjectStorage;
  /** The fake scanner in a demo: it flags only the EICAR test string. */
  scanner: MalwareScanner;
}

export interface SeededAppointment {
  id: string;
  entry: DemoAppointment;
  patientId: string;
  professionalId: string;
}

interface Person {
  userId: string;
  membershipId: string;
  staff: { roles: readonly Role[] };
}

export interface Stage2Input {
  tenantId: string;
  now: Date;
  withTenant: WithTenant;
  keys: Parameters<typeof createNoteService>[0]['keys'];
  clock: () => Date;
  documents: DemoDocumentsDeps | undefined;
  /**
   * The connection of the platform operator's database role (the only one that may verify a
   * matricula). Absent when the seed runs without the operator: the demo then has no professional
   * who may prescribe, and no prescription.
   */
  operatorDb?: Db | undefined;
  /**
   * The prescription provider the demo organizations use: the in-memory fake the process holds, so
   * what the seed issues is known to the provider console. Absent: the seed uses a fake of its own.
   */
  prescriptionProvider?: FakePrescriptionProvider | undefined;
  reception: Person;
  people: ReadonlyMap<string, Person>;
  professionalIds: ReadonlyMap<string, string>;
  appointments: readonly SeededAppointment[];
}

const noJobs: JobClient = { enqueue: () => Promise.resolve(null) };

function auditActorOf(
  userId: string,
  role: AuditActor['actingRole'],
): AuditActor & { userId: string } {
  return { userId, actingRole: role, ip: null, userAgent: 'demo-seed', requestId: null };
}

/** What the professionals wrote about the visits of the day. Fictitious, like everything else. */
const VISIT_NOTES: Record<'cardiology' | 'pediatrics', readonly Record<string, unknown>[]> = {
  cardiology: [
    {
      reasonForConsultation: 'Control de la presión arterial',
      symptoms: 'Sin síntomas. Toma la medicación todos los días.',
      measurements: [{ name: 'Presión arterial', value: '128/78', unit: 'mmHg' }],
      diagnosis: 'Hipertensión arterial controlada',
      plan: 'Continuar con el tratamiento. Control en tres meses.',
    },
    {
      reasonForConsultation: 'Resultados de laboratorio y electrocardiograma',
      symptoms: 'Sin dolor ni palpitaciones.',
      measurements: [{ name: 'Frecuencia cardíaca', value: '70', unit: 'lpm' }],
      diagnosis: 'Electrocardiograma sin cambios respecto del anterior',
      plan: 'Sin cambios en la medicación. Repetir el laboratorio en seis meses.',
    },
    {
      reasonForConsultation: 'Chequeo cardiológico anual',
      symptoms: 'Asintomático.',
      diagnosis: 'Examen cardiovascular normal',
      plan: 'Control en un año.',
    },
  ],
  pediatrics: [
    {
      reasonForConsultation: 'Control de salud del niño',
      measurements: [
        { name: 'Peso', value: '27', unit: 'kg' },
        { name: 'Talla', value: '128', unit: 'cm' },
      ],
      diagnosis: 'Crecimiento y desarrollo acordes a la edad',
      plan: 'Calendario de vacunación al día. Próximo control en seis meses.',
    },
    {
      reasonForConsultation: 'Fiebre de dos días',
      symptoms: 'Fiebre de hasta 38,5 grados, buena tolerancia oral, sin tos.',
      measurements: [{ name: 'Temperatura', value: '38,2', unit: '°C' }],
      diagnosis: 'Cuadro viral',
      plan: 'Hidratación y control de la temperatura. Consultar si la fiebre dura más de tres días.',
    },
    {
      reasonForConsultation: 'Control de salud',
      diagnosis: 'Sin hallazgos',
      plan: 'Control anual.',
    },
  ],
};

/** Past visits that were attended and today's visit in progress, newest first. */
function visitsOf(appointments: readonly SeededAppointment[], key: DemoProfessionalKey) {
  const mine = appointments.filter((item) => item.entry.professional === key);
  const byRecent = (a: SeededAppointment, b: SeededAppointment) =>
    b.entry.date.localeCompare(a.entry.date) || b.entry.startMinute - a.entry.startMinute;
  return {
    attended: mine.filter((item) => item.entry.status === 'attended').sort(byRecent),
    inProgress: mine.filter((item) => item.entry.status === 'in_progress').sort(byRecent),
  };
}

export interface SeededVisit {
  appointment: SeededAppointment;
  encounterId: string;
  noteId: string;
  professional: 'cardiology' | 'pediatrics';
}

/** Opens, writes and signs the notes of the visits. Returns the visits that got a note. */
async function seedConsultations(input: Stage2Input): Promise<SeededVisit[]> {
  const { tenantId, withTenant } = input;
  const notes = createNoteService({ keys: input.keys, appointments: findCareSourceAppointment });
  const amendments = createAmendmentService({ keys: input.keys });
  const visits: SeededVisit[] = [];

  for (const key of ['cardiology', 'pediatrics'] as const) {
    const person = input.people.get(key);
    const professionalId = input.professionalIds.get(key);
    if (!person || !professionalId) continue;
    const context = { tenantId, userId: person.userId, actingProfessionalId: professionalId };
    const caller: Caller = {
      actor: auditActorOf(person.userId, 'professional'),
      professionalId,
      tenantActive: true,
    };
    const { attended, inProgress } = visitsOf(input.appointments, key);
    const plan = [
      ...attended.slice(0, 2).map((appointment) => ({ appointment, sign: true })),
      ...inProgress.slice(0, 1).map((appointment) => ({ appointment, sign: false })),
    ];
    for (const [position, { appointment, sign }] of plan.entries()) {
      const content = VISIT_NOTES[key][position % VISIT_NOTES[key].length];
      if (!content) continue;
      const opened = await withTenant(context, (tx) =>
        notes.open(tx, caller, {
          patientId: appointment.patientId,
          templateKind: 'general',
          appointmentId: appointment.id,
        }),
      );
      await withTenant(context, (tx) =>
        notes.saveDraft(tx, caller, {
          encounterId: opened.encounterId,
          request: { content, baseRevision: 0 },
        }),
      );
      if (sign) {
        await withTenant(context, (tx) =>
          notes.sign(tx, caller, { noteId: opened.id, expectedRevision: 1 }),
        );
      }
      visits.push({
        appointment,
        encounterId: opened.encounterId,
        noteId: opened.id,
        professional: key,
      });
      // The first signed note of the cardiologist gets a correction: the history shows an addendum
      // that came from the visit itself.
      if (key === 'cardiology' && sign && position === 0) {
        await withTenant(context, (tx) =>
          amendments.addAddendum(tx, caller, {
            noteId: opened.id,
            request: {
              kind: 'correction',
              reason: 'Se completa un dato de la consulta',
              text: 'El paciente aclaró después de la consulta que toma la medicación por la mañana.',
            },
          }),
        );
      }
    }
  }
  return visits;
}

interface DemoFile {
  uploader: 'reception' | 'cardiology' | 'pediatrics';
  category: CreateUploadsRequest['category'];
  name: string;
  contentType: CreateUploadsRequest['files'][number]['contentType'];
  build: () => Buffer;
  /** The visit (by order in the list of visits of that professional) the file came with. */
  fromVisit?: number;
  /** Which patient of the visits (administrative files only). */
  patientOfVisit?: { professional: 'cardiology' | 'pediatrics'; visit: number };
}

const FILES: readonly DemoFile[] = [
  {
    uploader: 'reception',
    category: 'id_copy',
    name: 'DNI frente y dorso.pdf',
    contentType: 'application/pdf',
    build: () => minimalPdf('DNI frente y dorso (copia de demostración)'),
    patientOfVisit: { professional: 'cardiology', visit: 0 },
  },
  {
    uploader: 'reception',
    category: 'coverage_card',
    name: 'Credencial de la obra social.png',
    contentType: 'image/png',
    build: minimalPng,
    patientOfVisit: { professional: 'cardiology', visit: 0 },
  },
  {
    uploader: 'reception',
    category: 'signed_form',
    name: 'Consentimiento informado firmado.pdf',
    contentType: 'application/pdf',
    build: () => minimalPdf('Consentimiento informado (documento de demostración)'),
    patientOfVisit: { professional: 'pediatrics', visit: 0 },
  },
  {
    uploader: 'cardiology',
    category: 'lab_result',
    name: 'Laboratorio completo.pdf',
    contentType: 'application/pdf',
    build: () => minimalPdf('Laboratorio completo (resultado de demostración)'),
    fromVisit: 0,
  },
  {
    uploader: 'cardiology',
    category: 'imaging',
    name: 'Electrocardiograma.png',
    contentType: 'image/png',
    build: minimalPng,
    fromVisit: 0,
  },
  {
    uploader: 'cardiology',
    category: 'referral',
    name: 'Derivación a ergometría.jpg',
    contentType: 'image/jpeg',
    build: minimalJpeg,
    fromVisit: 1,
  },
  {
    uploader: 'pediatrics',
    category: 'clinical_report',
    name: 'Informe de vacunación.pdf',
    contentType: 'application/pdf',
    build: () => minimalPdf('Informe de vacunación (documento de demostración)'),
    fromVisit: 0,
  },
  {
    // A file the scanner refuses: the list shows the rejection and nobody can download it.
    uploader: 'reception',
    category: 'other_administrative',
    name: 'Archivo sospechoso.txt',
    contentType: 'text/plain',
    build: () => Buffer.from(EICAR, 'latin1'),
    patientOfVisit: { professional: 'cardiology', visit: 1 },
  },
];

async function seedDocuments(
  input: Stage2Input,
  documents: DemoDocumentsDeps,
  visits: readonly SeededVisit[],
): Promise<void> {
  const { tenantId, withTenant } = input;
  const uploads = createUploadService({
    storage: documents.storage,
    jobs: noJobs,
    clock: input.clock,
  });
  const scan = createScanJob({
    storage: documents.storage,
    scanner: documents.scanner,
    jobs: noJobs,
    clock: input.clock,
  });
  const visitsOfProfessional = (professional: 'cardiology' | 'pediatrics') =>
    visits.filter((visit) => visit.professional === professional);

  for (const file of FILES) {
    const person = input.people.get(file.uploader === 'reception' ? 'reception' : file.uploader);
    if (!person) continue;
    const professionalId =
      file.uploader === 'reception' ? null : (input.professionalIds.get(file.uploader) ?? null);
    const visit =
      file.fromVisit === undefined
        ? file.patientOfVisit
          ? visitsOfProfessional(file.patientOfVisit.professional)[file.patientOfVisit.visit]
          : undefined
        : visitsOfProfessional(file.uploader as 'cardiology' | 'pediatrics')[file.fromVisit];
    if (!visit) continue;

    const actor: Actor = {
      kind: 'staff',
      userId: person.userId,
      tenantId,
      membershipId: person.membershipId,
      roles: person.staff.roles,
      grants: [],
      professionalId,
    };
    const context = {
      tenantId,
      userId: person.userId,
      ...(professionalId ? { actingProfessionalId: professionalId } : {}),
    };
    const auditActor = auditActorOf(
      person.userId,
      file.uploader === 'reception' ? 'reception' : 'professional',
    );
    const bytes = file.build();
    const clinical = file.fromVisit !== undefined;

    const { uploads: created } = await withTenant(context, (tx) =>
      uploads.create(tx, {
        actor,
        request: {
          patientId: visit.appointment.patientId,
          category: file.category,
          // A clinical file belongs to the visit it came with; an administrative one only to the patient.
          ...(clinical
            ? { encounterId: visit.encounterId, appointmentId: visit.appointment.id }
            : {}),
          files: [{ name: file.name, contentType: file.contentType, size: bytes.length }],
        },
      }),
    );
    const document = created[0];
    if (!document) throw new Error('the upload was not registered');
    // The browser's part: send the file to the quarantine place the upload named.
    await documents.storage.put(tenantId, tenantKey(tenantId, 'quarantine', document.id), {
      body: bytes,
      contentType: file.contentType,
    });
    await withTenant(context, (tx) =>
      uploads.complete(tx, { actor, auditActor, documentId: document.id }),
    );
    // The worker's part: the scan, here and now (the fake scanner decides).
    await withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
      scan.handler({
        tx,
        tenantId,
        payload: { tenantId, documentId: document.id },
        job: { id: uuidv7(), name: SCAN_JOB, enqueuedAt: input.now, retryCount: 0 },
      }),
    );
  }
}

/** Everything the Stage 2 modules add to the demo, after the agenda and the first notes exist. */
export async function seedStage2(input: Stage2Input): Promise<void> {
  const visits = await seedConsultations(input);
  if (input.documents) await seedDocuments(input, input.documents, visits);
}
