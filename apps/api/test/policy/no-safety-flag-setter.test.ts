import * as contracts from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createRuntimeDb } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';

/**
 * Nobody sets or clears the safety flag by hand (patients, "Safety alerts without clinical
 * detail"). The flag follows the anamnesis and nothing else, so no request in the product has a
 * field for it and no route is named after it. The database has the last word (a trigger), and
 * this policy keeps the application from ever offering the door.
 */

const FLAG_KEY = /safety|flag/i;
const REQUEST_NAME = /(Request|Input|Body|Query)$/;

/** Every key of every object schema reachable from `schema`, however deeply nested. */
function collectKeys(schema: unknown, seen = new Set<unknown>()): string[] {
  if (typeof schema !== 'object' || schema === null || seen.has(schema)) return [];
  seen.add(schema);
  const keys: string[] = [];
  const definition = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!definition) return keys;
  const shape = definition['shape'];
  if (typeof shape === 'object' && shape !== null) {
    for (const [key, child] of Object.entries(shape)) {
      keys.push(key, ...collectKeys(child, seen));
    }
  }
  for (const name of ['element', 'innerType', 'in', 'out', 'left', 'right', 'valueType']) {
    keys.push(...collectKeys(definition[name], seen));
  }
  const options = definition['options'];
  if (Array.isArray(options)) {
    for (const option of options) keys.push(...collectKeys(option, seen));
  }
  return keys;
}

function requestSchemas(): [string, unknown][] {
  return Object.entries(contracts).filter(
    ([name, value]) => REQUEST_NAME.test(name) && typeof value === 'object',
  );
}

describe('no request schema can set the safety flag', () => {
  it('finds the request schemas to check (the guard is not silently empty)', () => {
    const names = requestSchemas().map(([name]) => name);

    expect(names.length).toBeGreaterThan(20);
    expect(names).toEqual(
      expect.arrayContaining([
        'CreatePatientRequest',
        'UpdatePatientRequest',
        'SaveAnamnesisRequest',
      ]),
    );
  });

  it('has no safety or flag field in any request, at any depth', () => {
    const offenders = requestSchemas().flatMap(([name, schema]) =>
      collectKeys(schema)
        .filter((key) => FLAG_KEY.test(key))
        .map((key) => `${name}.${key}`),
    );

    expect(offenders).toEqual([]);
  });

  it('would notice one (the scanner works on nested, optional and union schemas)', () => {
    const nested = z.strictObject({
      patient: z.array(
        z.strictObject({
          details: z.strictObject({ safetyFlags: z.array(z.string()) }).optional(),
        }),
      ),
    });
    const union = z.union([
      z.strictObject({ a: z.string() }),
      z.strictObject({ hasSafetyFlag: z.boolean() }),
    ]);
    const clean = z.strictObject({ name: z.string() });

    expect(collectKeys(nested).filter((key) => FLAG_KEY.test(key))).toEqual(['safetyFlags']);
    expect(collectKeys(union).filter((key) => FLAG_KEY.test(key))).toEqual(['hasSafetyFlag']);
    expect(collectKeys(clean).filter((key) => FLAG_KEY.test(key))).toEqual([]);
  });

  it('exposes the flag only as a read-only fact on responses: hasSafetyFlag', () => {
    expect(Object.keys(contracts.PatientDto.shape)).toContain('hasSafetyFlag');
    expect(Object.keys(contracts.PatientSummaryDto.shape)).toContain('hasSafetyFlag');
    expect(Object.keys(contracts.PatientDto.shape).filter((key) => FLAG_KEY.test(key))).toEqual([
      'hasSafetyFlag',
    ]);
  });
});

describe('no route is named after the flag', () => {
  it('registers no route whose path mentions it, for any method', async () => {
    const app = buildTestApplication(createRuntimeDb('postgres://nobody:nothing@127.0.0.1:1/none'));
    await app.ready();

    const routes = [...app.routeCategories.keys()];

    expect(routes.length).toBeGreaterThan(30);
    expect(routes.filter((route) => FLAG_KEY.test(route))).toEqual([]);
    await app.close();
  });
});
