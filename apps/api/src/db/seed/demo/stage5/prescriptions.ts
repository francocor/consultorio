import type { PrescriptionItem } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import {
  createFakePrescriptionProvider,
  type FakePrescriptionProvider,
} from '../../../../adapters/erx-fake/index.js';
import type { AdapterResolver } from '../../../../main/adapter-resolver.js';
import type { PrescriptionDeps } from '../../../../modules/prescriptions/application/common.js';
import { putConnection } from '../../../../modules/prescriptions/application/connection.js';
import { cancelPrescription } from '../../../../modules/prescriptions/application/corrections.js';
import {
  createPrescription,
  type Caller,
} from '../../../../modules/prescriptions/application/issue.js';
import { settleFromProvider } from '../../../../modules/prescriptions/application/settle.js';
import { attemptSubmit } from '../../../../modules/prescriptions/application/submit.js';
import type { Tx } from '../../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../../platform/db/uuid.js';
import { prescription } from '../../../schema/prescriptions.js';

import {
  auditActorOf,
  contextOf,
  professionalIdOf,
  type Stage5Context,
  type Stage5People,
  type StoryPatient,
} from './shared.js';

/**
 * The prescription part of the Stage 5 demo (task 5.47): the organization's e-prescription switch
 * on for the simulator, and the prescriptions of the cardiologist, whose matricula the platform
 * verified. They go through the services the API and the worker run (the form, the submission to the
 * provider, the status check, the cancellation), and the provider is the in-memory fake of the
 * demo organizations: nothing is sent outside the process.
 *
 * - Valentina has a prescription the provider confirmed (the one the demo journey downloads from
 *   the portal) and an older one a pharmacy already dispensed.
 * - Joaquín's is confirmed (the e-prescription journey of the browser suite uses another patient, so its counts stay its own), and Martina's was cancelled with a reason after the control.
 */

type Medication = Pick<
  PrescriptionItem,
  'genericName' | 'dose' | 'form' | 'quantity' | 'instructions'
>;

const ENALAPRIL: Medication = {
  genericName: 'Enalapril',
  dose: '10 mg',
  form: 'comprimidos',
  quantity: 30,
  instructions: 'Un comprimido por la mañana, todos los días.',
};
const ATORVASTATIN: Medication = {
  genericName: 'Atorvastatina',
  dose: '20 mg',
  form: 'comprimidos',
  quantity: 30,
  instructions: 'Un comprimido por la noche.',
};
const LOSARTAN: Medication = {
  genericName: 'Losartán',
  dose: '50 mg',
  form: 'comprimidos',
  quantity: 30,
  instructions: 'Un comprimido cada 12 horas.',
};
const AMLODIPINE: Medication = {
  genericName: 'Amlodipina',
  dose: '5 mg',
  form: 'comprimidos',
  quantity: 30,
  instructions: 'Un comprimido por día.',
};

/** A resolver that hands the demo organization the one provider of the process. */
function resolverOf(provider: FakePrescriptionProvider): AdapterResolver {
  return {
    forTenant: ((_tenant: unknown, port: string) =>
      port === 'prescriptionProvider' ? provider : undefined) as AdapterResolver['forTenant'],
  };
}

export async function seedPrescriptions(
  context: Stage5Context,
  people: Stage5People,
  patients: Record<'valentina' | 'joaquin' | 'martina', StoryPatient>,
  options: { cardiologistVerified: boolean },
): Promise<void> {
  const provider = context.prescriptionProvider ?? createFakePrescriptionProvider();
  const deps: PrescriptionDeps = {
    keys: context.keys,
    adapters: resolverOf(provider),
    clock: context.clock,
    withTenant: context.withTenant,
    ...(context.documents ? { storage: context.documents.storage } : {}),
  };

  // The organization switches e-prescription on for the simulator.
  await context.withTenant(contextOf(context, people.owner), (tx) =>
    putConnection(tx, deps, {
      actor: auditActorOf(people.owner, 'owner'),
      request: { enabled: true },
    }),
  );
  // Nobody may prescribe until the platform has verified a registration.
  if (!options.cardiologistVerified) return;

  const professionalId = professionalIdOf(people.cardiology);
  const actor = auditActorOf(people.cardiology, 'professional');
  const caller: Caller = { actor, professionalId };
  const asCardiologist = <T>(fn: (tx: Tx) => Promise<T>) =>
    context.withTenant(contextOf(context, people.cardiology), fn);

  /** Makes the prescription, sends it to the provider and returns its identifiers. */
  async function issue(patient: StoryPatient, items: Medication[]) {
    const { id } = await asCardiologist((tx) =>
      createPrescription(tx, deps, caller, { clientKey: uuidv7(), patientId: patient.id, items }),
    );
    const outcome = await asCardiologist((tx) =>
      attemptSubmit(tx, deps, id, { force: true, actor }),
    );
    if (outcome !== 'issued') {
      throw new Error(`The demo prescription was not issued (${outcome}).`);
    }
    const [row] = await asCardiologist((tx) =>
      tx
        .select({ externalId: prescription.externalId })
        .from(prescription)
        .where(eq(prescription.id, id)),
    );
    if (!row?.externalId) throw new Error('The demo prescription has no identifier.');
    return { id, externalId: row.externalId };
  }

  // Valentina: an older one a pharmacy dispensed, and the one she downloads in the portal.
  const dispensed = await issue(patients.valentina, [ATORVASTATIN]);
  provider.advance(dispensed.externalId, 'dispensed');
  await asCardiologist((tx) => settleFromProvider(tx, deps, dispensed.id));
  await issue(patients.valentina, [ENALAPRIL]);

  await issue(patients.joaquin, [LOSARTAN]);

  // Martina's was cancelled after the control, through the provider.
  const cancelled = await issue(patients.martina, [AMLODIPINE]);
  const outcome = await asCardiologist((tx) =>
    cancelPrescription(tx, deps, caller, {
      prescriptionId: cancelled.id,
      request: { reason: 'Se indicó otro tratamiento después del control.' },
    }),
  );
  if (outcome !== 'cancelled')
    throw new Error(`The demo prescription was not cancelled (${outcome}).`);
}
