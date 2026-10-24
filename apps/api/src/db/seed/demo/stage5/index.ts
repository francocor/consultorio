import type { DemoContributor } from '../contributors.js';

import { seedConsents } from './consent.js';
import { verifyDemoMatricula } from './matricula.js';
import { seedPortalAccess, seedSharedDocument } from './portal.js';
import { seedPrescriptions } from './prescriptions.js';
import { findStoryPatients, peopleOf, type Stage5Context } from './shared.js';

/**
 * The Stage 5 part of the demo (tasks 5.47 and 5.49): the platform operator verified the
 * cardiologist's matricula, a patient and the representative of a newborn have access to the
 * portal, the consents of the organization are in every state, and the cardiologist's
 * prescriptions went through the in-memory fake of the provider. The order matters: the portal
 * identities exist before a consent is signed or revoked from the portal, and the matricula is
 * verified before anything is prescribed.
 */
export const seedStage5: DemoContributor = async (context: Stage5Context) => {
  const people = peopleOf(context);
  const patients = await findStoryPatients(context);

  const verified = await verifyDemoMatricula(context, people);
  const portal = await seedPortalAccess(context, people, patients);
  await seedSharedDocument(context, people, patients.valentina);
  await seedConsents(context, people, patients, portal);
  await seedPrescriptions(context, people, patients, { cardiologistVerified: verified });
};
