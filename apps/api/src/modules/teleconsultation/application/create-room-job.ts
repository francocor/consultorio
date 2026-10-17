import { defineJob } from '../../../platform/jobs/define-job.js';

import {
  completeRoomCreation,
  VIDEO_LINK_CREATE_JOB,
  VideoLinkJobPayload,
  type SessionDeps,
} from './video-sessions.js';

/**
 * The worker's `video.link.create` job: creates the room of a virtual appointment at the provider.
 * A read-only organization has no new rooms (category `write`, like reminders): the job ends
 * cancelled and the session stays pending until a person attaches a manual link.
 */
export function createVideoLinkCreateJob(deps: Pick<SessionDeps, 'adapters'>) {
  return defineJob({
    name: VIDEO_LINK_CREATE_JOB,
    category: 'write',
    payload: VideoLinkJobPayload,
    handler: ({ tx, payload, job }) => completeRoomCreation(tx, deps, payload, job.retryCount),
  });
}
