import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createConfiguredEmail } from './email.js';

describe('configured email', () => {
  it('uses SMTP when a mail server is configured', () => {
    const email = createConfiguredEmail({
      host: 'localhost',
      port: 1025,
      security: 'none',
      from: 'Consulvia <no-responder@localhost>',
    });

    expect(email.kind).toBe('smtp');
    email.close();
  });

  it('falls back to an in-memory sender that delivers nothing when there is no server', async () => {
    const email = createConfiguredEmail(undefined);

    expect(email.kind).toBe('fake');
    await expect(
      email.sender.send({ to: 'a@b.example', subject: 's', text: 't' }),
    ).resolves.toBeUndefined();
  });
});

describe('configured email with an outbox', () => {
  it('writes the messages to a folder when there is a folder and no server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'consulvia-email-'));
    try {
      const email = createConfiguredEmail(undefined, {
        dir,
        from: 'Consulvia <no-responder@localhost>',
      });

      expect(email.kind).toBe('outbox');
      await email.sender.send({ to: 'a@b.example', subject: 's', text: 't' });
      expect((await readdir(dir)).sort().map((name) => name.split('.').at(-1))).toEqual([
        'eml',
        'json',
      ]);
      email.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prefers the mail server when both are given', () => {
    const email = createConfiguredEmail(
      {
        host: 'localhost',
        port: 1025,
        security: 'none',
        from: 'Consulvia <no-responder@localhost>',
      },
      { dir: tmpdir(), from: 'Consulvia <no-responder@localhost>' },
    );

    expect(email.kind).toBe('smtp');
    email.close();
  });
});
