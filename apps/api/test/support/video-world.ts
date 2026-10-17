import { randomUUID } from 'node:crypto';

import type { AppointmentDto, AppointmentTypeDto } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { expect } from 'vitest';

import { createLocalVideoLinkProvider } from '../../src/adapters/video-local/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import { videoSession, type VideoSessionRow } from '../../src/db/schema/teleconsultation.js';
import type { AdapterResolver } from '../../src/main/adapter-resolver.js';
import { MODULE_WIRINGS } from '../../src/main/wiring/index.js';
import type {
  VideoLinkProvider,
  VideoRoom,
} from '../../src/modules/teleconsultation/application/ports.js';
import { createVideoLinkCreateJob } from '../../src/modules/teleconsultation/index.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { runJob, type JobRunResult } from '../../src/platform/jobs/define-job.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';

import { createRecordingJobClient, runPending, type RecordingJobClient } from './jobs.js';
import { createSchedulingHttpWorld, type SchedulingHttpWorld } from './scheduling-world.js';
import { asTenant } from './tenants.js';

/** The provider of a test: the local adapter, with a log of what it was asked and a failure switch. */
export interface SpyProvider extends VideoLinkProvider {
  /** Every room name the provider received, in order. */
  readonly asked: string[];
  /** Makes the next calls fail with this error, or work again with `null`. */
  failWith(error: Error | null): void;
}

export function createSpyProvider(allowedDomains: readonly string[]): SpyProvider {
  const base = createLocalVideoLinkProvider({ allowedDomains });
  const asked: string[] = [];
  let failure: Error | null = null;
  return {
    name: base.name,
    manualLinkDomains: base.manualLinkDomains,
    asked,
    failWith: (error) => {
      failure = error;
    },
    createRoom(opaqueId): Promise<VideoRoom> {
      asked.push(opaqueId);
      return failure ? Promise.reject(failure) : base.createRoom(opaqueId);
    },
    joinUrl: (room) => base.joinUrl(room),
  };
}

export interface VideoWorld extends SchedulingHttpWorld {
  jobs: RecordingJobClient;
  provider: SpyProvider;
  /** Swaps what the resolver returns for the organization: another provider, or none. */
  useProvider(provider: VideoLinkProvider | undefined): void;
  /** The id of a virtual appointment type. */
  virtual: string;
  /** The clock of the video module (the join window), apart from the scheduling clock. */
  setVideoNow(date: Date): void;
  videoNow(): Date;
  /** Books a virtual appointment on the Monday `weeksAfter` weeks after 2031-05-12. */
  bookVirtual(weeksAfter: number, time: string): Promise<AppointmentDto>;
  /** Runs the `video.link.create` jobs that are waiting. */
  runVideoJobs(): Promise<{ name: string; result: JobRunResult }[]>;
  /** Drops the jobs still waiting and the provider's log, so a test sees only its own work. */
  forgetPastWork(): void;
  /** The payload of the room-creation job queued for an appointment. */
  jobPayloadFor(appointmentId: string): Record<string, unknown>;
  /** Runs one delivery of a job payload, as the queue would, with this retry count. */
  runVideoJob(payload: Record<string, unknown>, retryCount: number): Promise<JobRunResult>;
  sessionOf(appointmentId: string): Promise<VideoSessionRow | null>;
  roomOf(appointmentId: string): Promise<string | null>;
  /** The audit entries of an action about an appointment, newest first. */
  auditsOf(action: string, appointmentId: string): Promise<(typeof auditEvent.$inferSelect)[]>;
}

export const ALLOWED_DOMAINS = ['meet.google.com', 'zoom.us'];

/**
 * A scheduling world with the video module wired as `main` wires it, on test doubles for what
 * leaves the process: a recording job queue, a spy provider and a clock of its own.
 */
export async function createVideoWorld(
  runtime: DbHandle,
  options: { slug: string; allowedDomains?: readonly string[] },
): Promise<VideoWorld> {
  const jobs = createRecordingJobClient();
  const provider = createSpyProvider(options.allowedDomains ?? ALLOWED_DOMAINS);
  let current: VideoLinkProvider | undefined = provider;
  let videoNow = new Date('2031-05-05T12:00:00.000Z');
  const videoClock = () => videoNow;

  const adapters: AdapterResolver = {
    // Only the video port is asked for in these tests.
    forTenant: () => current as never,
  };
  const wiring = MODULE_WIRINGS.map((entry) =>
    entry.name === 'teleconsultation'
      ? {
          ...entry,
          create: (context: Parameters<typeof entry.create>[0]) =>
            entry.create({ ...context, clock: videoClock }),
        }
      : entry,
  );

  const base = await createSchedulingHttpWorld(runtime, {
    slug: options.slug,
    app: { jobs, adapters, wiring },
  });
  const virtual = (
    await base.api.post('/appointment-types', base.owner, {
      name: 'Consulta virtual',
      durationMinutes: 30,
      mode: 'virtual',
    })
  ).json<AppointmentTypeDto>().id;

  const jobDeps = { adapters, clock: videoClock };
  const jobDefinition = createVideoLinkCreateJob(jobDeps);
  const sessionOf = (appointmentId: string) =>
    asTenant(runtime, base.tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(videoSession)
        .where(eq(videoSession.appointmentId, appointmentId));
      return row ?? null;
    });

  return Object.assign(base, {
    jobs,
    provider,
    useProvider: (next: VideoLinkProvider | undefined) => {
      current = next;
    },
    virtual,
    setVideoNow: (date: Date) => {
      videoNow = date;
    },
    videoNow: () => videoNow,
    bookVirtual: (weeksAfter: number, time: string) =>
      base.book(weeksAfter, time, { appointmentTypeId: virtual }),
    runVideoJobs: () => runPending(runtime.db, jobs, [jobDefinition]),
    runVideoJob: (payload: Record<string, unknown>, retryCount: number) =>
      runJob(runtime.db, jobDefinition, {
        id: randomUUID(),
        name: jobDefinition.name,
        data: { tenantId: base.tenant.id, ...payload },
        enqueuedAt: new Date(),
        retryCount,
      }),
    forgetPastWork: () => {
      for (const job of jobs.jobs) job.done = true;
      provider.asked.length = 0;
    },
    jobPayloadFor: (appointmentId: string) => {
      const job = jobs.jobs.find(
        (candidate) => candidate.payload['appointmentId'] === appointmentId,
      );
      if (!job) throw new Error(`no video.link.create job for ${appointmentId}`);
      return job.payload;
    },
    sessionOf,
    roomOf: (appointmentId: string) =>
      asTenant(runtime, base.tenant.id, async (tx) => {
        const [row] = await tx
          .select({ room: appointment.videoRoom })
          .from(appointment)
          .where(eq(appointment.id, appointmentId));
        expect(row, 'the appointment exists').toBeDefined();
        return row?.room ?? null;
      }),
    auditsOf: (action: string, appointmentId: string) =>
      asTenant(runtime, base.tenant.id, (tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(and(eq(auditEvent.action, action), eq(auditEvent.resourceId, appointmentId)))
          .orderBy(desc(auditEvent.occurredAt)),
      ),
  });
}

export { createActionTokens };
