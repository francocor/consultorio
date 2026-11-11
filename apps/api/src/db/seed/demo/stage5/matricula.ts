import { createOperatorRun } from '../../../../modules/operator/application/context.js';
import { createOperatorMatricula } from '../../../../modules/operator/application/matricula.js';

import { professionalIdOf, type Stage5Context, type Stage5People } from './shared.js';

/**
 * The platform operator that vouches for the demo's matricula. It is the seed itself, not a person
 * of the platform: the verification is recorded with this identity in the trail of the organization
 * and in the platform trail, like the one a real operator makes in the console.
 */
export const DEMO_OPERATOR = {
  id: '0190a000-0000-7000-8000-0000000d5e01',
  email: 'siembra@demo.invalid',
  displayName: 'Siembra de la demostración',
} as const;

/** The registration of the cardiologist in the demo dataset (`dataset.ts`). */
const CARDIOLOGIST_REGISTRATION = { jurisdiction: 'AR-C', number: '41258' } as const;

/**
 * Verifies the matricula of the cardiologist, the one professional of the demo who may prescribe,
 * through the same function the operator console runs. The pediatrician and the psychologist stay
 * unverified on purpose: the console shows them in its queue, and the journeys of the matricula
 * and of the prescription rely on it. Returns false (and verifies nobody) when the seed runs
 * without the operator's database role, the only one the database lets verify.
 */
export async function verifyDemoMatricula(
  context: Stage5Context,
  people: Stage5People,
): Promise<boolean> {
  if (!context.operatorDb) return false;
  const operator = createOperatorMatricula({
    run: createOperatorRun(context.operatorDb),
    clock: context.clock,
  });
  await operator.verify(
    context.tenantId,
    professionalIdOf(people.cardiology),
    { ...CARDIOLOGIST_REGISTRATION, note: 'Verificada en la siembra de la demostración.' },
    DEMO_OPERATOR,
    { ip: null, userAgent: 'demo-seed', requestId: null },
  );
  return true;
}
