import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';

import { devVideoRoutes, type DevVideoControls } from './dev-routes.js';

const TENANT = '0190a000-0000-7000-8000-000000000001';
const APPOINTMENT = '0190a000-0000-7000-8000-000000000002';

function build(controls: DevVideoControls) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.withTypeProvider<ZodTypeProvider>();
  devVideoRoutes(() => controls)(app);
  return app;
}

describe('video simulator controls', () => {
  const apps: ReturnType<typeof build>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('answers the address a reminder would carry, and asks for the tenant and the appointment it is about', async () => {
    const asked: unknown[] = [];
    const app = build({
      issuePatientLink: (input) => {
        asked.push(input);
        return Promise.resolve({
          kind: 'link',
          url: 'https://aillu.consultorio.test/public/v/token',
          expiresAt: new Date(),
        });
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/operator/dev/video/links',
      payload: { tenantId: TENANT, appointmentId: APPOINTMENT },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: 'link',
      url: 'https://aillu.consultorio.test/public/v/token',
    });
    expect(asked).toEqual([{ tenantId: TENANT, appointmentId: APPOINTMENT }]);
  });

  it('gives no address when the appointment has none yet, and says why', async () => {
    const app = build({ issuePatientLink: () => Promise.resolve({ kind: 'pending' }) });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/operator/dev/video/links',
      payload: { tenantId: TENANT, appointmentId: APPOINTMENT },
    });

    expect(response.json()).toEqual({ kind: 'pending', url: null });
  });

  it.each([
    ['a missing appointment', { tenantId: TENANT }],
    ['an id that is not one', { tenantId: 'x', appointmentId: APPOINTMENT }],
    ['an extra field', { tenantId: TENANT, appointmentId: APPOINTMENT, role: 'owner' }],
  ])('refuses %s', async (_label, payload) => {
    const app = build({ issuePatientLink: () => Promise.resolve({ kind: 'pending' }) });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/operator/dev/video/links',
      payload,
    });

    expect(response.statusCode).toBe(400);
  });
});
