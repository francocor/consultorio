import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { buildTestApplication } from '../../../test/support/app.js';
import { createRuntimeDb } from '../../platform/db/pool.js';
import { JobPayload } from '../../platform/jobs/boss.js';
import { defineJob } from '../../platform/jobs/define-job.js';
import {
  ADAPTER_PORTS,
  assembleAdapterRegistry,
  createAdapterResolver,
} from '../adapter-resolver.js';

import { combineWorkerContributions, type WorkerContribution } from './worker.js';

import { MODULE_WIRINGS } from './index.js';

const MODULES_DIR = fileURLToPath(new URL('../../modules/', import.meta.url));

const context = {
  config: {} as never,
  db: {} as never,
};

describe('the module wiring (every shared registration, in one place per module)', () => {
  it('wires each Stage 3 module that has a directory, once', () => {
    const wired = MODULE_WIRINGS.map((wiring) => wiring.name);
    const directories = readdirSync(MODULES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(new Set(wired).size).toBe(wired.length);
    for (const name of ['notifications', 'online-booking', 'waitlist', 'teleconsultation']) {
      expect(directories, name).toContain(name);
      expect(wired, name).toContain(name);
    }
  });

  it('fills the demo slot of the ports it owns with fakes, so every port of the stage is covered', () => {
    const slots = MODULE_WIRINGS.flatMap((wiring) =>
      wiring.adapters ? [wiring.adapters(context)] : [],
    );
    const owned = slots.flatMap((slot) => Object.keys(slot)).sort();

    expect(owned).toEqual(['botChallenge', 'videoLink', 'whatsapp']);
    for (const slot of slots) {
      for (const entry of Object.values(slot)) expect(entry.demo.kind).toBe('fake');
    }
  });

  it('completes the adapter registry once the composition root adds its own ports', () => {
    const base = Object.fromEntries(
      ADAPTER_PORTS.filter((port) => !['whatsapp', 'videoLink', 'botChallenge'].includes(port)).map(
        (port) => [port, { real: undefined, demo: { adapter: {}, kind: 'fake' as const } }],
      ),
    );

    const registry = assembleAdapterRegistry([
      base,
      ...MODULE_WIRINGS.map((wiring) => wiring.adapters?.(context) ?? {}),
    ]);

    // Every demo slot is a fake and nothing is guessed: the resolver accepts the whole registry.
    expect(() => createAdapterResolver(registry)).not.toThrow();
    expect(Object.keys(registry).sort()).toEqual([...ADAPTER_PORTS].sort());
  });

  it('does nothing observable yet: the skeletons register no route of their own', async () => {
    const without = await routesOf(createApp([]));
    const withModules = await routesOf(createApp(MODULE_WIRINGS));

    expect(withModules).toEqual(without);
  });
});

function createApp(wiring: typeof MODULE_WIRINGS) {
  // Never connects: building the application only declares routes.
  const db = createRuntimeDb('postgres://nobody:nothing@127.0.0.1:1/none');
  return buildTestApplication(db, { wiring });
}

async function routesOf(app: ReturnType<typeof createApp>): Promise<string> {
  await app.ready();
  const printed = app.printRoutes({ commonPrefix: false });
  await app.close();
  return printed;
}

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
