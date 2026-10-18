import type { seedStage2 } from './stage2.js';
import { seedStage3 } from './stage3/index.js';

/**
 * What the later stages add to the demo organization. The seed runs the Stage 1 and 2 story
 * itself, then every contributor in this list, in order, with the same context (the people, the
 * professionals and the appointments of the day). A stage registers its seed HERE and nowhere
 * else: Stage 3 adds the messaging, booking, waitlist and video data (`stage3/`), the following
 * stages add theirs.
 */
export type DemoContributorContext = Parameters<typeof seedStage2>[0];

export type DemoContributor = (context: DemoContributorContext) => Promise<void>;

export const DEMO_CONTRIBUTORS: readonly DemoContributor[] = [seedStage3];

/** Runs the contributors one after the other; the first failure stops the seed. */
export async function runContributors(
  context: DemoContributorContext,
  contributors: readonly DemoContributor[] = DEMO_CONTRIBUTORS,
): Promise<void> {
  for (const contribute of contributors) await contribute(context);
}
