import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  createLocalWhatsAppControls,
  createLocalWhatsAppSender,
  type LocalWhatsAppControls,
} from '../../src/adapters/whatsapp-local/index.js';
import { describeWhatsAppContract } from '../../src/adapters/whatsapp-local/whatsapp.contract.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';

/**
 * The local WhatsApp simulator, on a real Postgres: it passes the contract of the port, and it
 * does what the simulator promises (modes, unapproved templates, numbers that are not on WhatsApp,
 * state shared between the API and the worker).
 */

const SECRET = 'a-local-secret-for-the-tests';
let runtime: DbHandle;
let controls: LocalWhatsAppControls;

beforeAll(() => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  controls = createLocalWhatsAppControls(runtime.db);
});

afterAll(async () => {
  await runtime.close();
});

beforeEach(async () => {
  await controls.setMode('ok');
  for (const number of await controls.unreachableNumbers()) {
    await controls.setUnreachable(number, false);
  }
});

const sender = () => createLocalWhatsAppSender({ db: runtime.db, appSecret: SECRET });

describeWhatsAppContract({
  name: 'local simulator (Postgres)',
  make: () => {
    const local = sender();
    return Promise.resolve({ sender: local, sign: (raw) => local.signBody(raw) });
  },
});

const request = (overrides: Record<string, unknown> = {}) => ({
  templateKey: 'appointment_reminder',
  to: '+5491144445555',
  vars: {
    name: 'Ana',
    organization: 'Aillu',
    date: 'lunes 12 de mayo',
    time: '10:00',
    place: 'Centro',
  },
  idempotencyKey: `local-${crypto.randomUUID()}`,
  ...overrides,
});

describe('the local WhatsApp simulator', () => {
  it('keeps what it was given in its phone: the number, the template and the text as read', async () => {
    const local = sender();
    const idempotencyKey = `local-${crypto.randomUUID()}`;

    const result = await local.send(request({ idempotencyKey, to: '+5491100001111' }));

    expect(result.status).toBe('accepted');
    const messages = await controls.messages(50);
    expect(messages.find((message) => message.number === '+5491100001111')).toMatchObject({
      direction: 'outbound',
      templateKey: 'appointment_reminder',
      status: 'accepted',
      providerMessageId: result.status === 'accepted' ? result.providerMessageId : '',
    });
    const body = messages.find((message) => message.number === '+5491100001111')?.body ?? '';
    expect(body).toContain('Hola Ana, le recordamos su turno en Aillu.');
    expect(body).toContain('Hora: 10:00');
    expect(body).toContain('BAJA');
  });

  it('gives the same provider id to two senders for one key: the API and the worker share the phone', async () => {
    const idempotencyKey = `local-${crypto.randomUUID()}`;

    const fromApi = await sender().send(request({ idempotencyKey }));
    const fromWorker = await sender().send(request({ idempotencyKey }));

    expect(fromApi).toEqual(fromWorker);
  });

  it('refuses a template the provider did not approve', async () => {
    expect(await sender().send(request({ templateKey: 'marketing_blast' }))).toEqual({
      status: 'rejected',
      reason: 'template_rejected',
    });
  });

  it('treats the reserved test prefix as a number that is not on WhatsApp', async () => {
    expect(await sender().send(request({ to: '+99910012000' }))).toEqual({
      status: 'rejected',
      reason: 'not_on_whatsapp',
    });
  });

  it('treats a number that is not a number as invalid', async () => {
    for (const to of ['abc', '1144445555', '+54', '']) {
      expect(await sender().send(request({ to })), to).toEqual({
        status: 'rejected',
        reason: 'invalid_number',
      });
    }
  });

  it('answers "retry later" in down mode and accepts again when it is back', async () => {
    await controls.setMode('down');
    const down = await sender().send(request());
    await controls.setMode('ok');
    const back = await sender().send(request());

    expect(down.status).toBe('retryable');
    expect(back.status).toBe('accepted');
  });

  it('rejects every template in reject_template mode', async () => {
    await controls.setMode('reject_template');

    expect(await sender().send(request())).toEqual({
      status: 'rejected',
      reason: 'template_rejected',
    });
    expect(await controls.mode()).toBe('reject_template');
  });

  it('does not take a message into its phone when it rejects it', async () => {
    const idempotencyKey = `local-${crypto.randomUUID()}`;
    await sender().send(request({ idempotencyKey, to: '+99910012000' }));

    const messages = await controls.messages(100);

    expect(messages.some((message) => message.number === '+99910012000')).toBe(false);
  });

  it('marks and unmarks a number as unreachable', async () => {
    const number = '+5491177778888';
    await controls.setUnreachable(number, true);
    const refused = await sender().send(request({ to: number }));
    await controls.setUnreachable(number, false);
    const accepted = await sender().send(request({ to: number }));

    expect(refused).toEqual({ status: 'rejected', reason: 'not_on_whatsapp' });
    expect(accepted.status).toBe('accepted');
    expect(await controls.unreachableNumbers()).not.toContain(number);
  });

  it('records the status of a message as the provider reports it, and never goes back', async () => {
    const accepted = await sender().send(request({ to: '+5491122223333' }));
    const providerMessageId = accepted.status === 'accepted' ? accepted.providerMessageId : '';

    await controls.setStatus(providerMessageId, 'delivered');
    await controls.setStatus(providerMessageId, 'read');
    await controls.setStatus(providerMessageId, 'delivered');

    const message = (await controls.messages(100)).find(
      (entry) => entry.providerMessageId === providerMessageId,
    );
    expect(message?.status).toBe('read');
  });

  it('records a reply typed into the phone, with an id for its event', async () => {
    const reply = await controls.recordInbound({ from: '+5491122223333', text: ' 1 ' });

    expect(reply.eventId.length).toBeGreaterThan(0);
    expect(reply.providerMessageId.length).toBeGreaterThan(0);
    const message = (await controls.messages(100)).find(
      (entry) => entry.providerMessageId === reply.providerMessageId,
    );
    expect(message).toMatchObject({
      direction: 'inbound',
      number: '+5491122223333',
      status: 'received',
      body: ' 1 ',
    });
  });
});
