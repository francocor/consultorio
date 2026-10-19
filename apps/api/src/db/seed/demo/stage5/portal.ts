import { createScanJob } from '../../../../modules/documents/application/scan-job.js';
import {
  createUploadService,
  SCAN_JOB,
} from '../../../../modules/documents/application/uploads.js';
import { majorityAgeOf } from '../../../../modules/portal/application/country.js';
import { shareDocument } from '../../../../modules/portal/application/document-shares.js';
import {
  activateInvitation,
  prepareInvitation,
  type IdentityDeps,
} from '../../../../modules/portal/application/identities.js';
import { createPortalSessions } from '../../../../modules/portal/application/sessions.js';
import type { Actor } from '../../../../platform/authz/actor.js';
import { SYSTEM_USER_ID } from '../../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../../platform/db/uuid.js';
import { minimalPdf } from '../../../../platform/files/test-files.js';
import type { JobClient } from '../../../../platform/jobs/boss.js';
import { tenantKey } from '../../../../platform/storage/object-storage.js';
import { createActionTokens } from '../../../../platform/tokens/index.js';

import {
  auditActorOf,
  contextOf,
  type Stage5Context,
  type Stage5People,
  type StoryPatient,
} from './shared.js';

/**
 * The portal part of the Stage 5 demo (task 5.47): a patient with access to their own record, the
 * representative of a newborn with access to the minor, and a document shared with the patient.
 * Both people were invited by reception and followed the activation link: the seed runs the same
 * two steps the staff route and the token handler run, and then closes the invitation, so no
 * activation link stays alive in the demo. Nobody is signed in (a session lives hours and needs a
 * code): the sign-in code is asked for in the portal and read in the provider console, from the
 * demo outbox.
 */

/** The portal identities of the story, by who they are. */
export interface PortalIdentities {
  valentina: string;
  paula: string;
}

/** The country whose age of majority the portal reads: the organization's (Argentina). */
const COUNTRY = 'AR';

const noJobs: JobClient = { enqueue: () => Promise.resolve(null) };

export async function seedPortalAccess(
  context: Stage5Context,
  people: Stage5People,
  patients: { valentina: StoryPatient; ian: StoryPatient },
): Promise<PortalIdentities> {
  const deps: IdentityDeps = {
    tokens: createActionTokens({ clock: context.clock }),
    sessions: createPortalSessions(),
    clock: context.clock,
    majorityAge: majorityAgeOf,
  };
  const reception = auditActorOf(people.reception, 'reception');

  // The patient is invited at their own address (the one on the record) and activates the access.
  const self = await context.withTenant(contextOf(context, people.reception), async (tx) => {
    const prepared = await prepareInvitation(tx, deps, {
      actor: reception,
      patientId: patients.valentina.id,
    });
    const outcome = await activateInvitation(tx, deps, {
      actor: reception,
      country: COUNTRY,
      identityId: prepared.identity.id,
      payload: {
        patientId: patients.valentina.id,
        relationship: 'self',
        invitedBy: reception.userId,
      },
    });
    if (outcome !== 'activated') throw new Error('The demo portal access was not activated.');
    await deps.tokens.revokeForSubject(tx, 'portal_activation', prepared.identity.id);
    return prepared.identity.id;
  });

  // The mother of the newborn is invited as the representative, after reception checked her papers.
  const representative = {
    email: 'paula.navarro@demo.invalid',
    relation: 'mother' as const,
    verificationNote: 'Presentó su DNI y la partida de nacimiento de Ian en el mostrador.',
  };
  const mother = await context.withTenant(contextOf(context, people.reception), async (tx) => {
    const prepared = await prepareInvitation(tx, deps, {
      actor: reception,
      patientId: patients.ian.id,
      representative,
    });
    const outcome = await activateInvitation(tx, deps, {
      actor: reception,
      country: COUNTRY,
      identityId: prepared.identity.id,
      payload: {
        patientId: patients.ian.id,
        relationship: 'representative',
        relation: representative.relation,
        verificationNote: representative.verificationNote,
        invitedBy: reception.userId,
      },
    });
    if (outcome !== 'activated') throw new Error('The demo representative was not activated.');
    await deps.tokens.revokeForSubject(tx, 'portal_activation', prepared.identity.id);
    return prepared.identity.id;
  });

  return { valentina: self, paula: mother };
}

/**
 * Reception scans a paper for the patient (the instructions after the check-up), the scanner
 * clears it, and reception shares it with the portal. Needs the bucket of the demo's files: without
 * one, the demo has no documents and shares none.
 */
export async function seedSharedDocument(
  context: Stage5Context,
  people: Stage5People,
  patient: StoryPatient,
): Promise<boolean> {
  const documents = context.documents;
  if (!documents) return false;
  const uploads = createUploadService({
    storage: documents.storage,
    jobs: noJobs,
    clock: context.clock,
  });
  const scan = createScanJob({
    storage: documents.storage,
    scanner: documents.scanner,
    jobs: noJobs,
    clock: context.clock,
  });
  const actor: Actor = {
    kind: 'staff',
    userId: people.reception.userId,
    tenantId: context.tenantId,
    membershipId: people.reception.membershipId,
    roles: context.reception.staff.roles,
    grants: [],
    professionalId: null,
  };
  const auditActor = auditActorOf(people.reception, 'reception');
  const context_ = contextOf(context, people.reception);
  const name = 'Indicaciones para el control.pdf';
  const bytes = minimalPdf('Indicaciones para el control (documento de demostración)');

  const { uploads: created } = await context.withTenant(context_, (tx) =>
    uploads.create(tx, {
      actor,
      request: {
        patientId: patient.id,
        category: 'other_administrative',
        files: [{ name, contentType: 'application/pdf', size: bytes.length }],
      },
    }),
  );
  const document = created[0];
  if (!document) throw new Error('The upload of the shared document was not registered.');
  await documents.storage.put(
    context.tenantId,
    tenantKey(context.tenantId, 'quarantine', document.id),
    {
      body: bytes,
      contentType: 'application/pdf',
    },
  );
  await context.withTenant(context_, (tx) =>
    uploads.complete(tx, { actor, auditActor, documentId: document.id }),
  );
  await context.withTenant({ tenantId: context.tenantId, userId: SYSTEM_USER_ID }, (tx) =>
    scan.handler({
      tx,
      tenantId: context.tenantId,
      payload: { tenantId: context.tenantId, documentId: document.id },
      job: { id: uuidv7(), name: SCAN_JOB, enqueuedAt: context.now, retryCount: 0 },
    }),
  );
  await context.withTenant(context_, (tx) =>
    shareDocument(tx, {
      actor: auditActor,
      document: { id: document.id, patientId: patient.id, classification: 'administrative' },
    }),
  );
  return true;
}
