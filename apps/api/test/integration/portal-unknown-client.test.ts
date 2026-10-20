import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { captureLogs, type LogCapture } from '../../src/testing/log-capture.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * JD-S5 R4-7: a client whose address is not known is counted by its user agent, which is not a
 * security boundary. The server says so in its log every time one reaches a portal route, so an
 * operator whose `TRUST_PROXY` does not match the proxies in front of the app finds out.
 */
const SLUG = 'portal-unknown-client';
const WARNING = 'the client address of a portal request is unknown';
let runtime: DbHandle;
let world: PortalWorld;
let logs: LogCapture;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  logs = captureLogs();
  world = await createPortalWorld(runtime, { slug: SLUG, ports: {}, logStream: logs.stream });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const warnings = () => logs.lines().filter((line) => line['msg'] === WARNING);

async function askForCode(visitor: ReturnType<PortalWorld['visitor']>, email: string) {
  return visitor.post(`/public/${SLUG}/portal/otp`, {
    email,
    challengeProof: await visitor.solve(),
  });
}

describe('a portal request from a client with no known address', () => {
  it('logs a warning that names the organization and the route, never the e-mail', async () => {
    const before = warnings().length;
    // A zone id is a valid address for Node but not for the trail: the client counts as unknown.
    const unknown = world.visitor({ ip: 'fe80::1%eth0', userAgent: 'curl/8.0' });

    const answered = await askForCode(unknown, 'quien@example.test');

    expect(answered.statusCode, answered.body).toBe(200);
    const written = warnings().slice(before);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ level: 40, tenantId: world.tenant.id });
    expect(JSON.stringify(written[0])).not.toContain('quien@example.test');
    expect(JSON.stringify(written[0])).not.toContain('curl/8.0');
  });

  it('logs nothing for a client with a known address', async () => {
    const before = warnings().length;

    const answered = await askForCode(world.visitor({ ip: '203.0.113.9' }), 'otro@example.test');

    expect(answered.statusCode, answered.body).toBe(200);
    expect(warnings().slice(before)).toHaveLength(0);
  });
});
