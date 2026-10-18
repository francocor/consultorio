import { describe, expect, it } from 'vitest';

import { EmailDeliveryError } from '../../platform/mail/email-sender.js';

import { createFakeEmailSender } from './index.js';

const message = {
  to: 'ana@clinica.example',
  subject: 'Hola',
  text: 'Cuerpo del mensaje',
};

describe('fake email sender', () => {
  it('captures what was sent, in order', async () => {
    const email = createFakeEmailSender();

    await email.send(message);
    await email.send({ ...message, to: 'luis@clinica.example', subject: 'Otro' });

    expect(email.sent.map((sent) => [sent.to, sent.subject])).toEqual([
      ['ana@clinica.example', 'Hola'],
      ['luis@clinica.example', 'Otro'],
    ]);
  });

  it('keeps only the latest messages, so a long-running process does not grow without bound (JD-S3 B16)', async () => {
    const email = createFakeEmailSender({ capacity: 3 });

    for (let index = 0; index < 5; index += 1) {
      await email.send({ ...message, subject: `Mensaje ${String(index)}` });
    }

    expect(email.sent.map((sent) => sent.subject)).toEqual(['Mensaje 2', 'Mensaje 3', 'Mensaje 4']);
  });

  it('finds the last message to an address and the links inside it', async () => {
    const email = createFakeEmailSender();
    await email.send({
      ...message,
      text: 'Abrí https://clinica.consultorio.test/auth/reset?token=abc123 ahora',
    });

    expect(email.lastTo('ana@clinica.example')?.subject).toBe('Hola');
    expect(email.lastTo('nobody@clinica.example')).toBeUndefined();
    expect(email.linkIn(email.lastTo('ana@clinica.example'))).toBe(
      'https://clinica.consultorio.test/auth/reset?token=abc123',
    );
  });

  it('matches addresses without regard to case', async () => {
    const email = createFakeEmailSender();
    await email.send({ ...message, to: 'Ana@Clinica.example' });

    expect(email.lastTo('ana@clinica.EXAMPLE')).toBeDefined();
  });

  it('can be told to fail, as a provider outage would', async () => {
    const email = createFakeEmailSender({ failWith: new Error('smtp down') });

    await expect(email.send(message)).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(email.sent).toEqual([]);
  });

  it('forgets everything on reset', async () => {
    const email = createFakeEmailSender();
    await email.send(message);

    email.clear();

    expect(email.sent).toEqual([]);
  });
});
