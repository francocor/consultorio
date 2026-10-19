import type { DemoContributor } from '../contributors.js';

import { seedBilling } from './billing.js';
import { seedInvoicing } from './invoicing.js';
import { peopleOf, type Stage4Context } from './shared.js';

/**
 * The Stage 4 part of the demo (tasks 4.63 and 4.64): prices and payers, charges for the visits of
 * the last days, payments, refunds and the cash register of each day, and the invoices that went
 * through the demo fake issuer. The order matters: the invoices are made over the charges.
 */
export const seedStage4: DemoContributor = async (context: Stage4Context) => {
  const people = peopleOf(context);
  const billing = await seedBilling(context, people);
  await seedInvoicing(context, people, billing);
};
