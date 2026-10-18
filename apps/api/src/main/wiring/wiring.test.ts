import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SETTINGS_SECTION_KEYS } from '@consultorio/contracts';
import { describe, expect, it, vi } from 'vitest';

import { buildTestApplication } from '../../../test/support/app.js';
import { createRuntimeDb } from '../../platform/db/pool.js';
import { JobPayload } from '../../platform/jobs/boss.js';
import { defineJob } from '../../platform/jobs/define-job.js';
import { registerTokenHandler } from '../../platform/public/token-router.js';
import {
  ADAPTER_PORTS,
  assembleAdapterRegistry,
  createAdapterResolver,
} from '../adapter-resolver.js';
import { loadConfig } from '../config.js';

import { combineWorkerContributions, type WorkerContribution } from './worker.js';

import { MODULE_WIRINGS } from './index.js';

const MODULES_DIR = fileURLToPath(new URL('../../modules/', import.meta.url));

const context = {
  // Only what the adapter slots read: the customer slot of the bot challenge depends on it.
  config: { providers: { botChallenge: 'local' } } as never,
  db: {} as never,
};

describe('the module wiring (every shared registration, in one place per module)', () => {
  it('wires each Stage 3 and Stage 4 module that has a directory, once', () => {
    const wired = MODULE_WIRINGS.map((wiring) => wiring.name);
    const directories = readdirSync(MODULES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(new Set(wired).size).toBe(wired.length);
    for (const name of [
      'notifications',
      'online-booking',
      'waitlist',
      'teleconsultation',
      'billing',
      'invoicing',
      'reports',
    ]) {
      expect(directories, name).toContain(name);
      expect(wired, name).toContain(name);
    }
  });

  it('fills the demo slot of the ports it owns with fakes, so every port of the stage is covered', () => {
    const slots = MODULE_WIRINGS.flatMap((wiring) =>
      wiring.adapters ? [wiring.adapters(context)] : [],
    );
    const owned = slots.flatMap((slot) => Object.keys(slot)).sort();

    expect(owned).toEqual(['botChallenge', 'invoiceIssuer', 'videoLink', 'whatsapp']);
    for (const slot of slots) {
      for (const entry of Object.values(slot)) expect(entry.demo.kind).toBe('fake');
    }
  });

  it('completes the adapter registry once the composition root adds its own ports', () => {
    const base = Object.fromEntries(
      ADAPTER_PORTS.filter(
        (port) => !['whatsapp', 'videoLink', 'botChallenge', 'invoiceIssuer'].includes(port),
      ).map((port) => [port, { real: undefined, demo: { adapter: {}, kind: 'fake' as const } }]),
    );

    const registry = assembleAdapterRegistry([
      base,
      ...MODULE_WIRINGS.map((wiring) => wiring.adapters?.(context) ?? {}),
    ]);

    // Every demo slot is a fake and nothing is guessed: the resolver accepts the whole registry.
    expect(() => createAdapterResolver(registry)).not.toThrow();
    expect(Object.keys(registry).sort()).toEqual([...ADAPTER_PORTS].sort());
  });

  it('only ADDS routes: everything the application serves without the modules is still served with them', async () => {
    const without = await routesOf(createApp([]));
    const withModules = new Set(await routesOf(createApp(MODULE_WIRINGS)));

    expect(without.filter((route) => !withModules.has(route))).toEqual([]);
  });
});

function createApp(wiring: typeof MODULE_WIRINGS) {
  // Never connects: building the application only declares routes.
  const db = createRuntimeDb('postgres://nobody:nothing@127.0.0.1:1/none');
  return buildTestApplication(db, { wiring });
}

/** "METHOD /url" of every route the application serves. */
async function routesOf(app: ReturnType<typeof createApp>): Promise<string[]> {
  await app.ready();
  const routes = [...app.routeCategories.keys()];
  await app.close();
  return routes;
}

describe('the settings sections of the modules', () => {
  const owners = MODULE_WIRINGS.flatMap((wiring) =>
    (wiring.settingsSections ?? []).map((section) => [section.key, wiring.name] as const),
  );

  it('gives every section the contracts declare exactly one owner', () => {
    expect(owners.map(([key]) => key).sort()).toEqual([...SETTINGS_SECTION_KEYS].sort());
  });

  it('puts the Stage 4 sections in the module that owns them, and the einvoicing switch in the platform section', () => {
    expect(Object.fromEntries(owners)).toMatchObject({
      billing: 'billing',
      invoicing: 'invoicing',
      integrations: 'integrations',
    });
  });

  it('audits the einvoicing switch under the invoicing configuration action', () => {
    const integrations = MODULE_WIRINGS.flatMap((wiring) => wiring.settingsSections ?? []).find(
      (section) => section.key === 'integrations',
    );

    expect(integrations?.fieldAudits).toMatchObject({
      whatsapp: 'notification.integration.changed',
      einvoicing: 'invoicing.config.changed',
    });
  });

  it('starts with e-invoicing off and no late fee', () => {
    const defaults = Object.fromEntries(
      MODULE_WIRINGS.flatMap((wiring) => wiring.settingsSections ?? []).map((section) => [
        section.key,
        section.defaults,
      ]),
    );

    expect(defaults['integrations']).toMatchObject({ einvoicing: false });
    expect(defaults['billing']).toEqual({ lateFeeEnabled: false, lateFeeAmount: 0 });
    expect(defaults['invoicing']).toEqual({ outageThresholdHours: 24 });
  });
});

describe('the registry of public links', () => {
  const claimsTheConfirmKind = {
    name: 'claims-a-kind',
    create: () => {
      registerTokenHandler('appointment_confirm', {
        allowedWhenReadOnly: false,
        audits: [],
        describe: () => Promise.resolve(null),
        perform: () => Promise.resolve(null),
      });
      return {};
    },
  };

  it('refuses a module that claims a kind another module already took', () => {
    expect(() => createApp([...MODULE_WIRINGS, claimsTheConfirmKind])).toThrow(
      /appointment_confirm/,
    );
  });

  it('lets one process build the application again: each application starts with an empty registry', async () => {
    await routesOf(createApp(MODULE_WIRINGS));
    await expect(routesOf(createApp(MODULE_WIRINGS))).resolves.not.toHaveLength(0);
  });
});

describe('the simulator console entries of the modules', () => {
  const env = {
    DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
    BASE_DOMAIN: 'consultorio.test',
    PLATFORM_HOST: 'platform.consultorio.test',
    KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
  };
  const entriesFor = (overrides: Record<string, string> = {}) =>
    MODULE_WIRINGS.flatMap((wiring) =>
      wiring.devProviders
        ? wiring.devProviders({ config: loadConfig({ ...env, ...overrides }) })
        : [],
    );

  it('lists WhatsApp, the bot challenge, video and AFIP, each with the adapter that serves customers', async () => {
    const entries = entriesFor();

    expect(entries.map((entry) => entry.id).sort()).toEqual([
      'afip',
      'bot-challenge',
      'video',
      'whatsapp',
    ]);
    for (const entry of entries) {
      expect(await entry.status(), entry.id).toEqual({ adapter: 'local', mode: null });
    }
  });

  it('reports the real provider, or none, when the configuration selects it', async () => {
    const entries = entriesFor({
      NODE_ENV: 'production',
      ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
      KMS_PROVIDER: 'aws',
      AWS_REGION: 'sa-east-1',
      AWS_KMS_KEY_ID: 'alias/consultorio',
      SMTP_HOST: 'email-smtp.sa-east-1.amazonaws.com',
      SMTP_SECURITY: 'starttls',
      WHATSAPP_PROVIDER: 'meta',
      WHATSAPP_APP_SECRET: 'placeholder-app-secret-0123456789',
    });
    const status = async (id: string) => entries.find((entry) => entry.id === id)?.status();

    expect(await status('whatsapp')).toEqual({ adapter: 'real', mode: null });
    expect(await status('video')).toEqual({ adapter: 'off', mode: null });
    expect(await status('bot-challenge')).toEqual({ adapter: 'real', mode: null });
    // Production selects no AFIP simulator by default: invoicing is off until a provider is chosen.
    expect(await status('afip')).toEqual({ adapter: 'off', mode: null });
  });
});

describe('combining what the modules add to the worker', () => {
  const job = (name: string) =>
    defineJob({ name, category: 'write', payload: JobPayload, handler: () => Promise.resolve() });
  const a = job('module.a');
  const b = job('module.b');

  it('joins the jobs, the schedules and the tenant jobs of every module, in order', () => {
    const first: WorkerContribution = {
      jobs: () => [a],
      schedules: () => [{ name: 'tick a', intervalMs: 1000, run: () => Promise.resolve() }],
      tenantJobs: [{ definition: a, everyMs: 60_000 }],
    };
    const second: WorkerContribution = {
      jobs: () => [b],
      tenantJobs: [{ definition: b, everyMs: 5 }],
    };
    const worker = { client: {} as never, db: {} as never, metrics: {} as never, log: {} as never };

    const combined = combineWorkerContributions([first, {}, second]);

    expect(combined.jobs(worker).map((definition) => definition.name)).toEqual([
      'module.a',
      'module.b',
    ]);
    expect(combined.schedules(worker).map((schedule) => schedule.name)).toEqual(['tick a']);
    expect(combined.tenantJobs.map((entry) => entry.definition.name)).toEqual([
      'module.a',
      'module.b',
    ]);
  });

  it('hands each module the same worker context', () => {
    const seen = vi.fn(() => [] as never[]);
    const worker = { client: {} as never, db: {} as never, metrics: {} as never, log: {} as never };

    combineWorkerContributions([{ jobs: seen }, { jobs: seen }]).jobs(worker);

    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenNthCalledWith(1, worker);
    expect(seen).toHaveBeenNthCalledWith(2, worker);
  });

  it('is empty when no module adds anything', () => {
    const combined = combineWorkerContributions([{}, {}]);

    expect(combined.jobs({} as never)).toEqual([]);
    expect(combined.schedules({} as never)).toEqual([]);
    expect(combined.tenantJobs).toEqual([]);
  });
});
