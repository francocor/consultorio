import type { Tx } from '../../../platform/db/tenant-context.js';
import type { VideoNote } from '../domain/content.js';

/**
 * What the messages of a virtual appointment need from teleconsultation: the platform join address
 * the patient opens, or the reason there is none. The type is declared here, not imported, so the
 * two modules only meet at the composition root (`VideoJoinUrlResolver` of teleconsultation has
 * this very shape and is registered with `register`).
 *
 * - `in_person`: not a video appointment any more; nothing to say.
 * - `link`: the address, and when it stops working.
 * - `pending`: the appointment is virtual but its link does not exist yet.
 * - `closed`: cancelled, over, or the join window passed; nothing to send.
 */
export type VideoJoin =
  | { kind: 'in_person' }
  | { kind: 'pending' }
  | { kind: 'closed' }
  | { kind: 'link'; url: string; expiresAt: Date };

export interface VideoJoinResolver {
  /** Runs in the transaction that renders the message: issuing an address writes its token. */
  resolve(tx: Tx, appointmentId: string): Promise<VideoJoin>;
}

/**
 * The place where teleconsultation hands notifications its resolver. One registry exists per
 * application (and per worker process); the resolver it exposes asks whatever was registered, so
 * the order in which modules are built does not matter. Until a resolver is registered the video
 * link of a virtual appointment is "pending": the message says it follows rather than invent one.
 */
export interface VideoJoinRegistry {
  /** What the sending code asks. Never throws for lack of a registration. */
  readonly resolver: VideoJoinResolver;
  /** Registers the resolver. A second registration throws: two providers of one link is a bug. */
  register(resolver: VideoJoinResolver): () => void;
}

export function createVideoJoinRegistry(): VideoJoinRegistry {
  let registered: VideoJoinResolver | undefined;
  return {
    resolver: {
      resolve: (tx, appointmentId) =>
        registered ? registered.resolve(tx, appointmentId) : Promise.resolve({ kind: 'pending' }),
    },
    register(resolver) {
      if (registered !== undefined) {
        throw new Error('A video join resolver is already registered');
      }
      registered = resolver;
      return () => {
        if (registered === resolver) registered = undefined;
      };
    },
  };
}

/**
 * What a message says about the video call of a virtual appointment: the address when there is
 * one, that the link follows when there is none yet, and nothing when the appointment is no longer
 * a video one or its call is over.
 */
export function videoNoteOf(join: VideoJoin): VideoNote | undefined {
  switch (join.kind) {
    case 'link':
      return { kind: 'link', url: join.url };
    case 'pending':
      return { kind: 'pending' };
    case 'in_person':
    case 'closed':
      return undefined;
  }
}
