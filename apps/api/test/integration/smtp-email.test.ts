import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSmtpEmailSender } from '../../src/adapters/smtp/index.js';
import { EmailDeliveryError } from '../../src/platform/mail/email-sender.js';
import {
  renderInvitationEmail,
  renderPasswordResetEmail,
} from '../../src/platform/mail/templates.js';

/**
 * The SMTP adapter against a real Mailpit (the local mail catcher of docker compose), pinned to
 * the version of infra/docker-compose.yml. Nothing leaves the machine.
 */
let mailpit: StartedTestContainer;
let api: string;
let smtpPort: number;

beforeAll(async () => {
  mailpit = await new GenericContainer('axllent/mailpit:v1.31.6')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();
  api = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}`;
  smtpPort = mailpit.getMappedPort(1025);
}, 120_000);

afterAll(async () => {
  await mailpit.stop();
});

interface Summary {
  ID: string;
  Subject: string;
  From: { Address: string };
  To: { Address: string }[];
}

async function inbox(): Promise<Summary[]> {
  const response = await fetch(`${api}/api/v1/messages`);
  return ((await response.json()) as { messages: Summary[] }).messages;
}

async function body(id: string): Promise<{ Text: string; HTML: string }> {
  const response = await fetch(`${api}/api/v1/message/${id}`);
  return (await response.json()) as { Text: string; HTML: string };
}

const config = () => ({
  host: mailpit.getHost(),
  port: smtpPort,
  security: 'none' as const,
  from: 'Consultorio <no-responder@consultorio.test>',
});

describe('SMTP email adapter', () => {
  it('delivers a message with its text and HTML parts to the mail server', async () => {
    const sender = createSmtpEmailSender(config());
    const rendered = renderPasswordResetEmail({
      organizationName: 'Clínica Sur',
      link: 'https://sur.consultorio.test/auth/reset?token=abc',
      expiresInMinutes: 30,
    });

    await sender.send({ to: 'ana@clinica-sur.example', ...rendered });

    const messages = await inbox();
    const delivered = messages.find((message) => message.Subject === rendered.subject);
    expect(delivered).toBeDefined();
    expect(delivered?.From.Address).toBe('no-responder@consultorio.test');
    expect(delivered?.To.map((to) => to.Address)).toEqual(['ana@clinica-sur.example']);
    const content = await body(delivered?.ID ?? '');
    expect(content.Text).toContain('https://sur.consultorio.test/auth/reset?token=abc');
    expect(content.HTML).toContain('Elegir una contraseña nueva');
    sender.close();
  });

  it('keeps accents and the invitation wording intact (UTF-8, es-AR)', async () => {
    const sender = createSmtpEmailSender(config());
    const rendered = renderInvitationEmail({
      organizationName: 'Centro Médico Ñandú',
      inviterName: 'Ana Pérez',
      link: 'https://nandu.consultorio.test/auth/invitation?token=xyz',
      expiresInDays: 7,
    });

    await sender.send({ to: 'nuevo@nandu.example', ...rendered });

    const delivered = (await inbox()).find((message) => message.Subject.includes('Ñandú'));
    expect(delivered?.Subject).toBe('Invitación para unirse a Centro Médico Ñandú');
    expect((await body(delivered?.ID ?? '')).Text).toContain('La invitación la envió Ana Pérez');
    sender.close();
  });

  it('rejects with a delivery error when the server cannot be reached, without leaking the message', async () => {
    const sender = createSmtpEmailSender({ ...config(), port: 1, connectionTimeoutMs: 2000 });

    const failure = await sender
      .send({ to: 'secret-recipient@clinica.example', subject: 'Asunto', text: 'Cuerpo secreto' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmailDeliveryError);
    expect((failure as Error).message).not.toContain('secret-recipient');
    expect((failure as Error).message).not.toContain('Cuerpo secreto');
    sender.close();
  });
});
