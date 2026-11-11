import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import type { ObjectStorage } from '../../../platform/storage/object-storage.js';
import { createActionTokens } from '../../../platform/tokens/index.js';

import { releaseLinkRoutes } from './http/link-routes.js';

/**
 * The retention archive of Stage 6 (tenancy, "Retention archive after cancellation"): the records of
 * a cancelled organization, encrypted with a key of its own, in a write-once store that no routine
 * role can alter, and the break-glass release to the patient or a verified professional while the
 * operator never reads the content.
 *
 * What lives where:
 * - `write-archive.ts` and `verify-archive.ts` (jobs of the worker) write and check the archive;
 * - `release-archive.ts` (a job of the `releaser` process, the only holder of the key) carries out an
 *   approved release; `release-requests.ts` is the operator's side of it;
 * - this module serves the single-use link of a release (`http/link-routes.ts`), the only HTTP
 *   surface of the archive that is not the operator's.
 * The store is the `archiveStore` port of the adapter resolver (`ports.ts` says how it must behave).
 */

export interface ArchiveOptions {
  withTenant: WithTenant;
  /** Which store serves the archive (`forTenant(PLATFORM, 'archiveStore')`). */
  adapters?: AdapterResolver | undefined;
  /** Sends the release link to the requester and the notice to the former contact. */
  email: EmailSender;
  /** Queues `archive.write`, `archive.verify` and `archive.release`. */
  jobs?: JobClient | undefined;
  /** The bucket where a released package waits for its link. Absent: the link does not work. */
  storage?: ObjectStorage | undefined;
  clock?: () => Date;
}

export interface Archive {
  /** What the module was built with; the track builds its services from it. */
  readonly options: ArchiveOptions;
  /** The HTTP routes of the module (the single-use release link). */
  routes: (app: FastifyInstance) => void;
}

export function createArchive(options: ArchiveOptions): Archive {
  const clock = options.clock ?? (() => new Date());
  return {
    options,
    routes: releaseLinkRoutes({
      withTenant: options.withTenant,
      tokens: createActionTokens({ clock }),
      storage: options.storage,
      clock,
    }),
  };
}
