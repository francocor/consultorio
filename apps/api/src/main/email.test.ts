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
