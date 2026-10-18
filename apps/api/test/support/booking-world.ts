import { randomBytes } from 'node:crypto';

import type {
  BookingLinkDto,
  PublicHoldDto,
  PublicSubmissionRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

import {
  createLocalBotChallenge,
  solveProofOfWork,
} from '../../src/adapters/bot-challenge-local/index.js';
import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import { createFakeVideoLinkProvider } from '../../src/adapters/video-fake/index.js';
import type { AdapterPorts, AdapterResolver } from '../../src/main/adapter-resolver.js';
import { onlineBookingMetrics } from '../../src/main/wiring/online-booking.js';
import { createOtpSendJob } from '../../src/modules/online-booking/application/otp-send-job.js';
import { createBookingPurgeJob } from '../../src/modules/online-booking/application/purge.js';
import type { BotChallenge } from '../../src/platform/bot-challenge/bot-challenge.js';
import type { JobDefinition, JobRunResult } from '../../src/platform/jobs/define-job.js';
import type { Metrics } from '../../src/platform/metrics.js';

import { hostOf } from './app.js';
import { createRecordingJobClient, runPending, type RecordingJobClient } from './jobs.js';
import {
  createSchedulingHttpWorld,
  type Doctor,
  type SchedulingHttpWorld,
} from './scheduling-world.js';

/**
 * An adapter resolver that serves the given bot challenge to every organization, and a video
 * provider when asked to (organizations without one do not offer virtual appointments online).
 */
export function testAdapters(
  challenge: BotChallenge,
  options: { video?: boolean } = {},
): AdapterResolver {
  const video = createFakeVideoLinkProvider();
  return {
    forTenant: <P extends keyof AdapterPorts>(_tenant: unknown, port: P) =>
      (port === 'botChallenge'
        ? challenge
        : port === 'videoLink' && options.video === true
          ? video
          : undefined) as AdapterPorts[P] | undefined,
  };
}

/** A browser on the public pages of one organization: it keeps the anonymous booking cookie. */
export interface Visitor {
  readonly ip: string;
  /** The cookie jar, as the browser would send it. */
  cookie(): string;
  forget(): void;
  get(url: string): Promise<LightMyRequestResponse>;
  post(url: string, payload?: unknown): Promise<LightMyRequestResponse>;
  delete(url: string): Promise<LightMyRequestResponse>;
  /** Asks for a puzzle and solves it, the way the page does. */
  solve(): Promise<string>;
}

export interface BookingWorld extends SchedulingHttpWorld {
  email: FakeEmailSender;
  jobs: RecordingJobClient;
  /** What the module counts (one registry per process: tests compare before and after). */
  metrics: Metrics;
  /** The bot challenge the application uses (easy puzzles, so tests stay fast). */
  challenge: BotChallenge;
  /** Moves the clock of the whole application (scheduling, public flows, sessions). */
  advance(ms: number): void;
  visitor(options?: { ip?: string; userAgent?: string }): Visitor;
  /** Creates the organization link and one for the doctor, enabled, with the Consulta type. */
  openLinks(options?: {
    doctor?: Doctor;
    typeIds?: string[];
    locationIds?: string[];
  }): Promise<{ organization: BookingLinkDto; professional: BookingLinkDto }>;
  /** The public path of a professional page, e.g. `/public/<org>/p/<pro>`. */
  pagePath(links: { organization: BookingLinkDto; professional: BookingLinkDto }): string;
  /** The jobs the worker would run for this module, with the world's email and clock. */
  jobDefinitions: readonly JobDefinition[];
  /** Runs the jobs that are pending now, the way the worker would. */
  runJobs(): Promise<{ name: string; result: JobRunResult }[]>;
  /** A slot held by `visitor` on the Monday `weeksAfter` weeks after the first one (local time). */
  hold(
    visitor: Visitor,
    links: { organization: BookingLinkDto; professional: BookingLinkDto },
    options?: { weeksAfter?: number; time?: string },
  ): Promise<PublicHoldDto>;
  /** A valid form with a document and an email of its own; `overrides` change what a test needs. */
  form(
    overrides?: Partial<Omit<PublicSubmissionRequest, 'challengeProof'>>,
  ): Omit<PublicSubmissionRequest, 'challengeProof'>;
  /** The six digit code in the latest email sent to `address`. */
  codeSentTo(address: string): string;
}

let visitors = 0;
let forms = 0;

export async function createBookingWorld(
  runtime: Parameters<typeof createSchedulingHttpWorld>[0],
  options: {
    slug: string;
    now?: Date;
    app?: Parameters<typeof createSchedulingHttpWorld>[1]['app'];
    /** The organization has a video provider, so virtual types may be offered online. */
    video?: boolean;
  },
): Promise<BookingWorld> {
  const email = createFakeEmailSender();
  const jobs = createRecordingJobClient();
  const challenge = createLocalBotChallenge({ secret: randomBytes(32), difficulty: 6 });
  let current = options.now ?? new Date('2031-05-05T12:00:00.000Z');
  const base = await createSchedulingHttpWorld(runtime, {
    slug: options.slug,
    ...(options.now ? { now: options.now } : {}),
    app: {
      email,
      jobs,
      adapters: testAdapters(challenge, { video: options.video === true }),
      // One clock for the whole application, moved by `advance` and `setNow`.
      clock: () => current,
      ...options.app,
    },
  });

  const origin = `https://${hostOf(options.slug)}`;

  const visitor: BookingWorld['visitor'] = (visitorOptions = {}) => {
    visitors += 1;
    const ip =
      visitorOptions.ip ?? `10.77.${String(Math.floor(visitors / 250))}.${String(visitors % 250)}`;
    let jar = '';
    const app: FastifyInstance = base.app;
    const send = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
      const response = await app.inject({
        method,
        url,
        headers: {
          host: hostOf(options.slug),
          origin,
          'user-agent': visitorOptions.userAgent ?? 'vitest-visitor',
          ...(jar === '' ? {} : { cookie: jar }),
        },
        remoteAddress: ip,
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      const setCookie = response.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const pair = header?.split(';')[0];
      if (pair?.includes('=') && !/=$/.test(pair)) jar = pair;
      return response;
    };
    const self: Visitor = {
      ip,
      cookie: () => jar,
      forget: () => {
        jar = '';
      },
      get: (url) => send('GET', url),
      post: (url, payload) => send('POST', url, payload),
      delete: (url) => send('DELETE', url),
      solve: async () => {
        const response = await send('GET', '/public/challenge');
        expect(response.statusCode, response.body).toBe(200);
        return solveProofOfWork(response.json());
      },
    };
    return self;
  };

  const openLinks: BookingWorld['openLinks'] = async (linkOptions = {}) => {
    const target = linkOptions.doctor ?? base.doctor;
    const listed = await base.api.get('/booking-links', base.owner);
    expect(listed.statusCode, listed.body).toBe(200);
    const existing = listed
      .json<{ links: BookingLinkDto[] }>()
      .links.find((link) => link.professionalId === null);
    const organization = existing
      ? await base.api.patch(`/booking-links/${existing.id}`, base.owner, { enabled: true })
      : await base.api.post('/booking-links', base.owner, { enabled: true });
    expect(organization.statusCode, organization.body).toBeLessThan(300);
    const professional = await base.api.post('/booking-links', base.owner, {
      professionalId: target.professionalId,
      enabled: true,
      typeIds: linkOptions.typeIds ?? [base.consulta],
      locationIds: linkOptions.locationIds ?? [],
    });
    expect(professional.statusCode, professional.body).toBe(201);
    return {
      organization: organization.json<BookingLinkDto>(),
      professional: professional.json<BookingLinkDto>(),
    };
  };

  const jobDefinitions = [
    createOtpSendJob({ email, clock: () => current }),
    createBookingPurgeJob({ clock: () => current }),
  ];

  return {
    ...base,
    email,
    jobs,
    metrics: onlineBookingMetrics,
    challenge,
    jobDefinitions,
    runJobs: () => runPending(runtime.db, jobs, jobDefinitions),
    hold: async (who, links, holdOptions = {}) => {
      const weeksAfter = holdOptions.weeksAfter ?? 1;
      const time = holdOptions.time ?? '10:00';
      const hour = String(Number(time.slice(0, 2)) + 3).padStart(2, '0');
      const response = await who.post(`/public/${links.organization.slug}/booking/holds`, {
        professional: links.professional.slug,
        locationId: base.centro,
        appointmentTypeId: base.consulta,
        startsAt: `${base.monday(weeksAfter)}T${hour}:${time.slice(3)}:00.000Z`,
        challengeProof: await who.solve(),
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<PublicHoldDto>();
    },
    form: (overrides = {}) => {
      forms += 1;
      return {
        givenNames: 'Lucía',
        familyName: `Fernández ${String(forms)}`,
        document: { type: 'dni', number: String(30_000_000 + forms) },
        birthDate: '1990-04-02',
        email: `lucia${String(forms)}@example.test`,
        phone: '+54 11 5555 0000',
        whatsappOptIn: false,
        dataProcessingConsent: true,
        ...overrides,
      };
    },
    codeSentTo: (address) => {
      const message = email.lastTo(address);
      // The code is alone on its line; the organization's name may contain six digits.
      const code = message?.text.match(/^\s*(\d{6})\s*$/m)?.[1];
      if (!code) throw new Error(`no code was sent to ${address}`);
      return code;
    },
    now: () => current,
    setNow: (date) => {
      current = date;
      base.setNow(date);
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
      base.setNow(current);
    },
    visitor,
    openLinks,
    pagePath: ({ organization, professional }) =>
      `/public/${organization.slug}/p/${professional.slug}`,
    close: () => base.close(),
  };
}
