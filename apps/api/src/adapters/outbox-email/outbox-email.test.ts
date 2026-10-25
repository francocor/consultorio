import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EmailDeliveryError } from '../../platform/mail/email-sender.js';

import { createOutboxEmailSender } from './index.js';

const FROM = 'Consulvia <no-responder@localhost>';
const NOW = new Date('2026-10-20T15:30:45.123Z');

describe('the outbox email sender', () => {
  let root: string;
  let counter = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'consulvia-outbox-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A folder of its own for each test, not created yet: the sender makes it. */
  const folder = () => {
    counter += 1;
    return join(root, `outbox-${String(counter)}`);
  };

  const message = {
    to: 'ana@clinica.example',
    subject: 'Restablecer tu contraseña',
    text: 'Entra a http://127.0.0.1:41234/reset?token=abc123 para elegir una nueva.\n',
  };

  async function files(dir: string) {
    const names = (await readdir(dir)).sort();
    return {
      eml: names.filter((name) => name.endsWith('.eml')),
      json: names.filter((name) => name.endsWith('.json')),
      other: names.filter((name) => !name.endsWith('.eml') && !name.endsWith('.json')),
    };
  }

  it('writes each message as an .eml file with a small JSON entry beside it, and counts it as sent', async () => {
    const dir = folder();
    const sender = createOutboxEmailSender({ dir, from: FROM, clock: () => NOW });

    await expect(sender.send(message)).resolves.toBeUndefined();

    const found = await files(dir);
    expect(found.eml).toHaveLength(1);
    expect(found.json).toHaveLength(1);
    expect(found.other).toEqual([]);
    const raw = await readFile(join(dir, found.eml[0] ?? ''), 'utf8');
    expect(raw).toMatch(/^From: .*no-responder@localhost>?\r?$/m);
    expect(raw).toMatch(/^To: ana@clinica\.example\r?$/m);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(raw).toMatch(/^Message-ID: <.+@.+>\r?$/m);
    expect(raw).toMatch(/^Date: .*2026.*\r?$/m);
    expect(raw).toMatch(/^Content-Type: text\/plain; charset=utf-8\r?$/m);
    // Quoted-printable writes '=' as '=3D' when the message needs it; both are the same link.
    expect(raw).toMatch(/127\.0\.0\.1:41234\/reset\?token=(?:3D)?abc123/);

    const entry = JSON.parse(await readFile(join(dir, found.json[0] ?? ''), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(entry['id']).toMatch(/^[0-9a-f-]{36}$/);
    expect({ ...entry, id: undefined }).toEqual({
      id: undefined,
      file: found.eml[0],
      createdAt: NOW.toISOString(),
      from: FROM,
      to: 'ana@clinica.example',
      subject: 'Restablecer tu contraseña',
      links: ['http://127.0.0.1:41234/reset?token=abc123'],
    });
  });

  it('names the files so they sort by time and say nothing about the message', async () => {
    const dir = folder();
    let now = NOW;
    const sender = createOutboxEmailSender({ dir, from: FROM, clock: () => now });

    await sender.send(message);
    now = new Date(NOW.getTime() + 5000);
    await sender.send({ ...message, to: 'luis@sur.example' });

    const { eml } = await files(dir);
    expect([...eml].sort()).toEqual(eml);
    expect(eml[0]).toMatch(/^20261020T153045123Z-[0-9a-f]{8}\.eml$/);
    expect(eml[1]).toMatch(/^20261020T153050123Z-[0-9a-f]{8}\.eml$/);
    expect(eml.join('')).not.toContain('ana');
  });

  it('keeps every message of messages sent at the same moment', async () => {
    const dir = folder();
    const sender = createOutboxEmailSender({ dir, from: FROM, clock: () => NOW });

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        sender.send({ ...message, to: `persona${String(index)}@clinica.example` }),
      ),
    );

    const found = await files(dir);
    expect(found.eml).toHaveLength(12);
    expect(found.json).toHaveLength(12);
    expect(new Set(found.eml).size).toBe(12);
  });

  it('sends the text and the html of a message as alternatives', async () => {
    const dir = folder();
    const sender = createOutboxEmailSender({ dir, from: FROM, clock: () => NOW });

    await sender.send({ ...message, html: '<p>Hola</p>' });

    const raw = await readFile(join(dir, (await files(dir)).eml[0] ?? ''), 'utf8');
    expect(raw).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(raw).toContain('<p>Hola</p>');
  });

  it('cannot be made to add a header through the subject or the address', async () => {
    const dir = folder();
    const sender = createOutboxEmailSender({ dir, from: FROM, clock: () => NOW });

    await sender.send({ ...message, subject: 'Hola\r\nBcc: robo@evil.example' });

    const raw = await readFile(join(dir, (await files(dir)).eml[0] ?? ''), 'utf8');
    expect(raw).not.toMatch(/^Bcc:/im);
  });

  it('reports a folder it cannot write as a delivery failure that does not quote the message', async () => {
    const dir = folder();
    await writeFile(dir, 'a file where the folder should be');
    const sender = createOutboxEmailSender({ dir, from: FROM, clock: () => NOW });

    const failure = await sender.send(message).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmailDeliveryError);
    expect((failure as Error).message).not.toContain('ana@');
    expect((failure as Error).message).not.toContain('abc123');
  });

  it('does not list a message until its file is complete', async () => {
    const dir = folder();
    const sender = createOutboxEmailSender({ dir, from: FROM, clock: () => NOW });

    await sender.send(message);

    const found = await files(dir);
    const entry = JSON.parse(await readFile(join(dir, found.json[0] ?? ''), 'utf8')) as {
      file: string;
    };
    expect(found.eml).toContain(entry.file);
  });
});
