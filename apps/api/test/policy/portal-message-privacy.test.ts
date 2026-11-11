import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EMAIL_ONLY_MESSAGE_KINDS, type EmailOnlyMessageKind } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { selectChannels } from '../../src/modules/notifications/domain/channel-policy.js';
import {
  renderPortalCodeEmail,
  renderPortalInvitationEmail,
  renderPortalNoticeEmail,
  renderPortalRequestNoticeEmail,
} from '../../src/modules/portal/index.js';

/**
 * The privacy of the messages of the portal (S5.09, task 5.38; patient-portal "Privacy of portal
 * messages"): invitation, code, "you have a document" and "you have a consent to sign" go by email
 * only, never name a specialty, a title of a consent or a medication, and link to the authenticated
 * portal. The channel policy refuses WhatsApp for every one of those kinds.
 */

/** Words that would tell a stranger reading the inbox what the visit, the file or the paper is about. */
const CLINICAL_WORDS =
  /(cardiolog|pediatr|ginecolog|psiquiatr|psicolog|dermatolog|oncolog|traumatolog|urolog|diagn[oó]stic|receta|medicaci[oó]n|medicamento|ibuprofeno|amoxicilina|an[aá]lisis|estudio|tratamiento|operaci[oó]n|cirug[ií]a|consentimiento|\bHIV\b|embarazo)/i;

const ORGANIZATION = 'Centro Médico Aillu';
const PORTAL = 'https://aillu.consultorio.test/portal';

interface Rendered {
  label: string;
  subject: string;
  text: string;
  html: string;
}

function renderedMessages(): Rendered[] {
  const all: [string, { subject: string; text: string; html: string }][] = [
    [
      'invitation',
      renderPortalInvitationEmail({
        organizationName: ORGANIZATION,
        link: 'https://aillu.consultorio.test/public/t/abc',
        expiresInDays: 7,
      }),
    ],
    [
      'sign-in code',
      renderPortalCodeEmail({
        organizationName: ORGANIZATION,
        code: '048213',
        expiresInMinutes: 10,
        registration: false,
      }),
    ],
    [
      'registration code',
      renderPortalCodeEmail({
        organizationName: ORGANIZATION,
        code: '048213',
        expiresInMinutes: 10,
        registration: true,
      }),
    ],
    [
      'document available',
      renderPortalNoticeEmail({
        organizationName: ORGANIZATION,
        kind: 'document_available',
        link: PORTAL,
      }),
    ],
    [
      'consent request',
      renderPortalNoticeEmail({
        organizationName: ORGANIZATION,
        kind: 'consent_request',
        link: PORTAL,
      }),
    ],
  ];
  return all.map(([label, mail]) => ({ label, ...mail }));
}

describe('what the messages of the portal say', () => {
  it('never names a specialty, a consent, a medication or a reason for a visit', () => {
    for (const mail of renderedMessages()) {
      for (const [part, value] of [
        ['subject', mail.subject],
        ['text', mail.text],
        ['html', mail.html],
      ] as const) {
        expect(value, `${mail.label} ${part}`).not.toMatch(CLINICAL_WORDS);
      }
    }
  });

  it('says of a consent only that a document is waiting in the portal', () => {
    const mail = renderPortalNoticeEmail({
      organizationName: ORGANIZATION,
      kind: 'consent_request',
      link: PORTAL,
    });

    expect(mail.subject).toBe('Tiene un documento esperando en el portal de Centro Médico Aillu');
    expect(mail.text.split('\n')).toEqual([
      'Centro Médico Aillu le dejó un documento para revisar en su portal de pacientes.',
      '',
      'Para verlo, ingrese al portal con su correo:',
      '',
      PORTAL,
      '',
      'Este mensaje no incluye el contenido del documento.',
    ]);
  });

  it('links to the portal where one signs in, or to a single-use activation page, and a code carries no link', () => {
    const messages = renderedMessages();
    const links = (text: string) => text.match(/https?:\/\/\S+/g) ?? [];

    for (const mail of messages) {
      const found = links(mail.text);
      if (mail.label.endsWith('code')) {
        expect(found, mail.label).toEqual([]);
      } else {
        expect(found, mail.label).toHaveLength(1);
        expect(found[0], mail.label).toMatch(/\/portal$|\/public\/t\/[A-Za-z0-9_-]+$/);
      }
    }
  });

  it('tells the organization that a request exists and who made it, and nothing of what it says', () => {
    const mail = renderPortalRequestNoticeEmail({
      organizationName: ORGANIZATION,
      kind: 'copy',
      patientName: 'Ana Pérez',
      link: 'https://aillu.consultorio.test/patients/0190a000-0000-7000-8000-000000000001',
    });

    expect(mail.text).toContain('Ana Pérez pidió una copia de su historia clínica');
    expect(mail.text).toContain('Este mensaje no incluye el detalle de la solicitud.');
    expect(mail.text).not.toMatch(/diagn[oó]stico|receta|medicaci[oó]n/i);
  });
});

describe('the channel policy for these messages', () => {
  const FACTS = {
    email: 'ana@example.test',
    phone: '+54 11 5555 0000',
    emailPreference: 'default',
    whatsappPreference: 'opted_in',
    emailUnreachable: false,
    whatsappUnreachable: false,
  } as const;
  const OPTIONS = { whatsappEnabled: true, whatsappQuotaAvailable: true } as const;
  const KINDS: readonly EmailOnlyMessageKind[] = [
    'portal_notice',
    'consent_request',
    'otp_code',
    'invitation',
  ];

  it('refuses WhatsApp for every one of them, even for a patient who opted in and has a phone', () => {
    for (const kind of KINDS) {
      const decision = selectChannels(kind, FACTS, OPTIONS);

      expect(decision.channels, kind).toEqual(['email']);
      expect(
        decision.skipped.some((entry) => entry.channel === 'whatsapp'),
        kind,
      ).toBe(false);
    }
  });

  it('knows these kinds as email only, and not as the messages of an appointment', () => {
    for (const kind of KINDS) expect(EMAIL_ONLY_MESSAGE_KINDS).toContain(kind);
  });

  it('is not even approached by the portal: no code of the module sends anything but email', () => {
    const root = fileURLToPath(new URL('../../src/modules/portal', import.meta.url));
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(root);

    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((file) =>
      /whatsapp|sms|twilio/i.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
