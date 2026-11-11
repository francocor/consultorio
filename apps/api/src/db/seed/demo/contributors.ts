import type { seedStage2 } from './stage2.js';
import { seedStage3 } from './stage3/index.js';
import { seedStage4 } from './stage4/index.js';
import { seedStage5 } from './stage5/index.js';
import { seedStage6 } from './stage6/index.js';

/**
 * What the later stages add to the demo organization. The seed runs the Stage 1 and 2 story
 * itself, then every contributor in this list, in order, with the same context (the people, the
 * professionals and the appointments of the day). A stage registers its seed HERE and nowhere
 * else: Stage 3 adds the messaging, booking, waitlist and video data (`stage3/`), the following
 * stages add theirs. Stage 4 adds the prices, charges, payments, cash registers and invoices
 * (`stage4/`). Stage 5 adds the consents, the prescriptions, the verified matricula and the portal
 * accounts (`stage5/`). Stage 6 shows the exempt state of the demonstration organization (`stage6/`); the
 * organizations with a subscription are a separate seed (`pnpm demo:platform`).
 */
export type DemoContributorContext = Parameters<typeof seedStage2>[0];

export type DemoContributor = (context: DemoContributorContext) => Promise<void>;

export const DEMO_CONTRIBUTORS: readonly DemoContributor[] = [
  seedStage3,
  seedStage4,
  seedStage5,
  seedStage6,
];

/** Runs the contributors one after the other; the first failure stops the seed. */
export async function runContributors(
  context: DemoContributorContext,
  contributors: readonly DemoContributor[] = DEMO_CONTRIBUTORS,
): Promise<void> {
  for (const contribute of contributors) await contribute(context);
}
