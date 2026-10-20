import { randomBytes } from 'node:crypto';
import type { Writable } from 'node:stream';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { expect, inject } from 'vitest';

import {
  createLocalBotChallenge,
  solveProofOfWork,
} from '../../src/adapters/bot-challenge-local/index.js';
import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import { MODULE_WIRINGS } from '../../src/main/wiring/index.js';
import { createSignupWiring } from '../../src/main/wiring/signup.js';
import { createSignupWorker } from '../../src/modules/onboarding/index.js';
import type { StartTrialResult, TrialStarter } from '../../src/modules/subscriptions/index.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { createPublicOrigins } from '../../src/platform/http/public-origin.js';
import type { EmailMessage } from '../../src/platform/mail/email-sender.js';

import { BASE_DOMAIN, buildTestApplication, hostOf } from './app.js';
import { testAdapters } from './booking-world.js';

/** A trial door that remembers who it was asked for and can be told to refuse (S6.01 is not here). */
export interface RecordingTrialStarter extends TrialStarter {
  readonly calls: readonly string[];
  /** While set, the door refuses, as the seam's does before S6.01. */
  refuse: boolean;
}

export function createRecordingTrialStarter(): RecordingTrialStarter {
  const calls: string[] = [];
  const starter: RecordingTrialStarter = {
    calls,
    refuse: false,
    startTrial: (_tx, input) => {
      if (starter.refuse) return Promise.reject(new Error('the trial door is not built'));
      calls.push(input.tenantId);
      const result: StartTrialResult = {
        status: 'started',
        trialEndsAt: new Date('2031-06-01T00:00:00Z'),
      };
      return Promise.resolve(result);
    },
  };
  return starter;
}

/** An email provider that can be put down and brought back, for the retry of the verification. */
export interface SwitchableEmail extends FakeEmailSender {
  down: boolean;
}

function createSwitchableEmail(): SwitchableEmail {
  const inner = createFakeEmailSender();
  const switchable: SwitchableEmail = {
    down: false,
    get sent() {
      return inner.sent;
    },
    lastTo: (address) => inner.lastTo(address),
    linkIn: (message) => inner.linkIn(message),
    clear: () => {
      inner.clear();
    },
    send: (message: EmailMessage) =>
      switchable.down ? Promise.reject(new Error('provider down')) : inner.send(message),
  };
  return switchable;
}

let visitors = 0;
let signups = 0;

export interface Link {
  slug: string;
  token: string;
  url: string;
}

export interface SignupBody {
  organizationName: string;
  ownerName: string;
  email: string;
  password: string;
  acceptTerms: boolean;
  acceptDataProcessing: boolean;
  challengeProof: string;
}

export interface SignupWorld {
  app: FastifyInstance;
  email: SwitchableEmail;
  trial: RecordingTrialStarter;
  /** A connection that sees every row (the superuser of the test container): assertions only. */
  admin: pg.Client;
  now(): Date;
  advance(ms: number): void;
  /** A fresh client address, so the per-client counters of one test never touch another's. */
  ip(): string;
  /** Posts to the platform host (the form) from a client address. */
  platformPost(
    url: string,
    payload: unknown,
    options?: { ip?: string },
  ): Promise<LightMyRequestResponse>;
  platformGet(url: string, options?: { ip?: string }): Promise<LightMyRequestResponse>;
  /** Posts to the host of an organization (the page of a link). */
  tenantPost(
    slug: string,
    url: string,
    payload: unknown,
    options?: { ip?: string; cookie?: string },
  ): Promise<LightMyRequestResponse>;
  tenantGet(
    slug: string,
    url: string,
    options?: { ip?: string; cookie?: string },
  ): Promise<LightMyRequestResponse>;
  /** A solved bot challenge, asked from the platform host or from an unverified organization's. */
  solve(options?: { slug?: string; ip?: string }): Promise<string>;
  /** A valid form; `overrides` change what a test needs. A new address and name every time. */
  form(overrides?: Partial<Omit<SignupBody, 'challengeProof'>>): Omit<SignupBody, 'challengeProof'>;
  /** Solves a challenge and posts the form. */
  signUp(
    overrides?: Partial<Omit<SignupBody, 'challengeProof'>>,
    options?: { ip?: string },
  ): Promise<{ response: LightMyRequestResponse; form: Omit<SignupBody, 'challengeProof'> }>;
  /** Asks for a new link by address from the platform host, with a challenge solved for the same client. */
  resend(address: string, options?: { ip?: string }): Promise<LightMyRequestResponse>;
  /** Asks for a new link from the page of an unverified organization. */
  renew(slug: string, options?: { ip?: string }): Promise<LightMyRequestResponse>;
  /** The link of the last verification email sent to an address. */
  linkTo(address: string): Link;
  /** Waits for the work that started after the answers (the emails). */
  idle(): Promise<void>;
  /** The passes of the worker, with the world's email, origins and clock. */
  worker: ReturnType<typeof createSignupWorker>;
  /** Everything the server logged. */
  logs(): string;
  /** The organization with this address, if it exists, with its status. */
  tenantOf(slug: string): Promise<{ id: string; status: string } | undefined>;
  close(): Promise<void>;
}

export const PASSWORD = 'una frase larga y propia 2031';

export async function createSignupWorld(
  runtime: DbHandle,
  options: { now?: Date } = {},
): Promise<SignupWorld> {
  const email = createSwitchableEmail();
  const trial = createRecordingTrialStarter();
  const challenge = createLocalBotChallenge({ secret: randomBytes(32), difficulty: 6 });
  let current = options.now ?? new Date();
  const lines: string[] = [];
  const logStream = {
    write: (chunk: string) => {
      lines.push(chunk);
      return true;
    },
  } as unknown as Writable;

  const app = buildTestApplication(runtime, {
    email,
    adapters: testAdapters(challenge),
    clock: () => current,
    logLevel: 'info',
    logStream,
    wiring: [
      ...MODULE_WIRINGS.filter((module) => module.name !== 'signup'),
      createSignupWiring({ trial }),
    ],
  });
  await app.ready();

  const admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();

  const origins = createPublicOrigins({ mode: 'multi', baseDomain: BASE_DOMAIN }, { secure: true });
  const worker = createSignupWorker({
    db: runtime.db,
    email,
    origins,
    clock: () => current,
    onError: () => undefined,
  });

  const nextIp = () => {
    visitors += 1;
    return `10.88.${String(Math.floor(visitors / 250))}.${String(visitors % 250)}`;
  };
  const headers = (host: string, cookie?: string) => ({
    host,
    origin: `https://${host}`,
    'user-agent': 'vitest-visitor',
    ...(cookie === undefined ? {} : { cookie }),
  });
  const platformHost = `platform.${BASE_DOMAIN}`;

  const world: SignupWorld = {
    app,
    email,
    trial,
    admin,
    now: () => current,
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    ip: nextIp,
    platformPost: (url, payload, o = {}) =>
      app.inject({
        method: 'POST',
        url,
        headers: headers(platformHost),
        remoteAddress: o.ip ?? nextIp(),
        payload: payload as object,
      }),
    platformGet: (url, o = {}) =>
      app.inject({
        method: 'GET',
        url,
        headers: headers(platformHost),
        remoteAddress: o.ip ?? nextIp(),
      }),
    tenantPost: (slug, url, payload, o = {}) =>
      app.inject({
        method: 'POST',
        url,
        headers: headers(hostOf(slug), o.cookie),
        remoteAddress: o.ip ?? nextIp(),
        payload: payload as object,
      }),
    tenantGet: (slug, url, o = {}) =>
      app.inject({
        method: 'GET',
        url,
        headers: headers(hostOf(slug), o.cookie),
        remoteAddress: o.ip ?? nextIp(),
      }),
    solve: async (o = {}) => {
      const response =
        o.slug === undefined
          ? await world.platformGet(
              '/public/signup/challenge',
              o.ip === undefined ? {} : { ip: o.ip },
            )
          : await world.tenantGet(
              o.slug,
              '/public/signup/challenge',
              o.ip === undefined ? {} : { ip: o.ip },
            );
      expect(response.statusCode, response.body).toBe(200);
      return solveProofOfWork(response.json());
    },
    form: (overrides = {}) => {
      signups += 1;
      return {
        organizationName: `Centro Prueba ${String(signups)}`,
        ownerName: 'Ana Pérez',
        email: `dueno${String(signups)}-${randomBytes(3).toString('hex')}@example.test`,
        password: PASSWORD,
        acceptTerms: true,
        acceptDataProcessing: true,
        ...overrides,
      };
    },
    signUp: async (overrides = {}, o = {}) => {
      const form = world.form(overrides);
      const ip = o.ip ?? nextIp();
      const response = await world.platformPost(
        '/public/signup',
        { ...form, challengeProof: await world.solve({ ip }) },
        { ip },
      );
      return { response, form };
    },
    resend: async (address, o = {}) => {
      const ip = o.ip ?? nextIp();
      return world.platformPost(
        '/public/signup/resend',
        { email: address, challengeProof: await world.solve({ ip }) },
        { ip },
      );
    },
    renew: async (slug, o = {}) => {
      const ip = o.ip ?? nextIp();
      return world.tenantPost(
        slug,
        '/public/signup/renew',
        { challengeProof: await world.solve({ slug, ip }) },
        { ip },
      );
    },
    linkTo: (address) => {
      const url = email.linkIn(email.lastTo(address));
      if (!url) throw new Error(`no verification link was sent to ${address}`);
      const parsed = new URL(url);
      const token = parsed.searchParams.get('token');
      const slug = parsed.hostname.split('.')[0];
      if (!token || !slug) throw new Error(`not a verification link: ${parsed.pathname}`);
      return { slug, token, url };
    },
    idle: () => app.background.idle(),
    worker,
    logs: () => lines.join(''),
    tenantOf: async (slug) => {
      const result = await admin.query<{ id: string; status: string }>(
        'SELECT id, status FROM tenant WHERE slug = $1',
        [slug],
      );
      return result.rows[0];
    },
    close: async () => {
      await app.close();
      await admin.end();
    },
  };
  return world;
}
