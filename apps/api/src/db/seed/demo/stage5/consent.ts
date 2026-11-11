import { createRequestService } from '../../../../modules/consent/application/request-consent.js';
import { createRevocationService } from '../../../../modules/consent/application/revoke-consent.js';
import { createSigningService } from '../../../../modules/consent/application/sign-consent.js';
import { createTemplateService } from '../../../../modules/consent/application/templates.js';
import { findStarter } from '../../../../modules/consent/assets/starters/es-AR.js';
import type { AuditActor } from '../../../../platform/audit/writer.js';
import type { Tx } from '../../../../platform/db/tenant-context.js';
import { minimalPng } from '../../../../platform/files/test-files.js';

import type { PortalIdentities } from './portal.js';
import {
  auditActorOf,
  contextOf,
  type DemoPatientKey,
  type Stage5Context,
  type Stage5People,
  type Stage5Person,
  type StoryPatient,
} from './shared.js';

/**
 * The consent part of the Stage 5 demo (task 5.47): a template that went through two versions, a
 * second one with a single version and a draft; and consents in every state the services allow,
 * written by those same services, so the version binding, the fingerprint of the signature, the
 * encryption of the personal part and the triggers that move a request to signed and revoked are
 * the real ones.
 *
 * - The first template was published, asked for and signed, and then edited: the edit published
 *   version 2 and left version 1 as it was. A request made after it is bound to version 2.
 * - Valentina signed and later revoked version 1 from the portal. Version 2 waits for her signature
 *   in the portal: it is the consent the demo journey signs.
 * - Others signed at the reception device (one drawing the mark by hand), one declined, one request
 *   waits at the device, and a minor's consent was signed by the father as the representative.
 */

/** What version 2 adds to the text of the first template. Fictitious, like the rest. */
const VERSION_TWO_NOTE =
  'Aclaración de la segunda versión: autorizo también que se registre en mi historia clínica el resultado del procedimiento y las indicaciones que reciba al finalizarlo.';

/** The patient acting from the portal: no user behind it, and the entry says so. */
const PORTAL_AUDIT: AuditActor = {
  userId: null,
  actingRole: 'patient',
  ip: null,
  userAgent: 'demo-seed',
  requestId: null,
};

const pngDataUrl = () => `data:image/png;base64,${minimalPng().toString('base64')}`;

type Patients = Record<
  'valentina' | 'santiago' | 'martina' | 'joaquin' | 'sofia' | 'camila' | 'isabella',
  StoryPatient
>;

export type StoryPatients = Pick<Record<DemoPatientKey, StoryPatient>, keyof Patients>;

export async function seedConsents(
  context: Stage5Context,
  people: Stage5People,
  patients: Patients,
  portal: PortalIdentities,
): Promise<void> {
  const clock = context.clock;
  const templates = createTemplateService({ clock });
  const requests = createRequestService({ clock });
  const signing = createSigningService({ keys: context.keys, clock });
  const revocation = createRevocationService({ keys: context.keys, clock });
  const run = <T>(person: Stage5Person, fn: (tx: Tx) => Promise<T>) =>
    context.withTenant(contextOf(context, person), fn);

  const ownerActor = auditActorOf(people.owner, 'owner');
  const general = findStarter('general_care');
  const psychology = findStarter('psychology_treatment');
  if (!general || !psychology) throw new Error('The consent starters of the demo are missing.');

  // 1. The templates of the organization, written by its owner.
  const publish = async (starter: NonNullable<typeof general>) => {
    const created = await run(people.owner, (tx) =>
      templates.create(tx, {
        actor: ownerActor,
        request: {
          title: starter.title,
          body: starter.body,
          specialty: starter.specialty,
          starterKey: starter.key,
        },
      }),
    );
    await run(people.owner, (tx) =>
      templates.publish(tx, { actor: ownerActor, templateId: created.id }),
    );
    return created.id;
  };
  const generalId = await publish(general);
  const psychologyId = await publish(psychology);
  await run(people.owner, (tx) =>
    templates.create(tx, {
      actor: ownerActor,
      request: {
        title: 'Consentimiento informado para estudios con contraste',
        body: 'Borrador: el texto todavía se está redactando y no se ofrece a los pacientes.',
        specialty: 'general',
      },
    }),
  );

  const ask = (
    person: Stage5Person,
    patient: StoryPatient,
    templateId: string,
    method: 'in_person' | 'portal',
  ) =>
    run(person, (tx) =>
      requests.create(tx, {
        actor: auditActorOf(person, 'professional'),
        request: { patientId: patient.id, templateId, method },
      }),
    );
  const signAtDevice = (
    person: Stage5Person,
    request: { id: string; versionId: string },
    patient: StoryPatient,
    mark: { kind: 'typed'; name: string } | { kind: 'drawn'; imageDataUrl: string },
    representative?: { name: string; nationalId: string; relation: string },
  ) =>
    run(person, (tx) =>
      signing.sign(tx, {
        requestId: request.id,
        recorder: { kind: 'staff', userId: person.userId },
        auditActor: auditActorOf(person, 'professional'),
        request: {
          versionId: request.versionId,
          accepted: true,
          signer: representative ? 'representative' : 'patient',
          ...(representative ? { representative } : {}),
          mark,
        },
        patientId: patient.id,
      }),
    );

  // 2. Version 1 of the first template. Valentina asks through the portal, signs there and revokes
  // there. Two patients sign at the device of the reception, one of them drawing the mark.
  const valentina = await ask(people.cardiology, patients.valentina, generalId, 'portal');
  await run(people.cardiology, (tx) =>
    signing.sign(tx, {
      requestId: valentina.id,
      recorder: { kind: 'portal', identityId: portal.valentina },
      auditActor: PORTAL_AUDIT,
      request: {
        versionId: valentina.versionId,
        accepted: true,
        signer: 'patient',
        mark: { kind: 'typed', name: patients.valentina.fullName },
      },
      patientId: patients.valentina.id,
    }),
  );
  await run(people.cardiology, (tx) =>
    revocation.revoke(tx, {
      requestId: valentina.id,
      by: { kind: 'portal', identityId: portal.valentina },
      auditActor: PORTAL_AUDIT,
      request: { reason: 'Prefiero revisar el procedimiento con mi médico antes de autorizarlo.' },
      patientId: patients.valentina.id,
    }),
  );
  const santiago = await ask(people.cardiology, patients.santiago, generalId, 'in_person');
  await signAtDevice(people.cardiology, santiago, patients.santiago, {
    kind: 'typed',
    name: patients.santiago.fullName,
  });
  const martina = await ask(people.cardiology, patients.martina, generalId, 'in_person');
  await signAtDevice(people.cardiology, martina, patients.martina, {
    kind: 'drawn',
    imageDataUrl: pngDataUrl(),
  });
  // The psychologist's patient signs the second template and later asks, at the desk, to withdraw it.
  const camila = await ask(people.psychology, patients.camila, psychologyId, 'in_person');
  await signAtDevice(people.psychology, camila, patients.camila, {
    kind: 'typed',
    name: patients.camila.fullName,
  });
  await run(people.psychology, (tx) =>
    revocation.revoke(tx, {
      requestId: camila.id,
      by: { kind: 'staff', userId: people.psychology.userId },
      auditActor: auditActorOf(people.psychology, 'professional'),
      request: { reason: 'Pidió retirar su consentimiento en el consultorio.' },
      patientId: patients.camila.id,
    }),
  );

  // 3. The first template is edited: version 2 is published, version 1 stays as it was.
  await run(people.owner, (tx) =>
    templates.update(tx, {
      actor: ownerActor,
      templateId: generalId,
      request: { body: `${general.body}\n\n${VERSION_TWO_NOTE}` },
    }),
  );

  // 4. Asked for on version 2. The consent that waits in the portal for Valentina is the one the
  // demo journey signs; one patient declined at the desk, one request waits at the device, and a
  // minor's consent was signed by the father as the representative.
  await ask(people.cardiology, patients.valentina, generalId, 'portal');
  const joaquin = await ask(people.cardiology, patients.joaquin, generalId, 'in_person');
  await run(people.cardiology, (tx) =>
    requests.decline(tx, {
      requestId: joaquin.id,
      actor: {
        ...auditActorOf(people.cardiology, 'professional'),
        userId: people.cardiology.userId,
      },
    }),
  );
  await ask(people.cardiology, patients.sofia, generalId, 'in_person');
  const isabella = await ask(people.pediatrics, patients.isabella, generalId, 'in_person');
  await signAtDevice(
    people.pediatrics,
    isabella,
    patients.isabella,
    { kind: 'typed', name: 'Gustavo Domínguez' },
    { name: 'Gustavo Domínguez', nationalId: '99100022', relation: 'Padre' },
  );
}
