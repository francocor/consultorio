import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';

/**
 * The retention archive of Stage 6 (tenancy, "Retention archive after cancellation"): the records of
 * a cancelled organization, encrypted with a key of its own, in a write-once store that no routine
 * role can alter, and the break-glass release to the patient or a verified professional while the
 * operator never reads the content.
 *
 * Seam skeleton: the module is registered through the tenancy `index.ts` and does nothing yet. The
 * retention track (Track C, S6.09 and S6.10) adds files under this folder and edits this one. The
 * store is the `archiveStore` port of the adapter resolver (`ports.ts` says how it must behave).
 */

export interface ArchiveOptions {
  withTenant: WithTenant;
  /** Which store serves the archive (`forTenant(PLATFORM, 'archiveStore')`). */
  adapters?: AdapterResolver | undefined;
  /** Sends the release link to the requester and the notice to the former contact. */
  email: EmailSender;
  /** Queues `archive.write`, `archive.verify` and `archive.release`. */
  jobs?: JobClient | undefined;
  clock?: () => Date;
}

export interface Archive {
  /** What the module was built with; the track builds its services from it. */
  readonly options: ArchiveOptions;
  /** The HTTP routes of the module (the single-use release link). */
  routes: (app: FastifyInstance) => void;
}

export function createArchive(options: ArchiveOptions): Archive {
  return { options, routes: () => undefined };
}
