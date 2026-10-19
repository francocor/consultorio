import { describe, expect, it } from 'vitest';

import {
  renderPortalCodeEmail,
  renderPortalInvitationEmail,
  renderPortalNoticeEmail,
  renderPortalSecurityNoticeEmail,
} from './mail.js';

/** Words that would tell a stranger reading the inbox what the visit or the file is about. */
const CLINICAL_WORDS =
  /(cardiolog|pediatr|ginecolog|psiquiatr|psicolog|dermatolog|diagn[oó]stic|receta|medicaci[oó]n|estudio|an[aá]lisis|tratamiento|consentimiento informado|\bHIV\b|oncolog)/i;

const ORGANIZATION = 'Centro Médico Aillu';
const LINK = 'https://aillu.consultorio.test/public/t/abc';

describe('the emails of the portal', () => {
  it('invites with a link that expires and says nothing about the person or the care', () => {
    const mail = renderPortalInvitationEmail({
      organizationName: ORGANIZATION,
      link: LINK,
      expiresInDays: 7,
    });

    expect(mail.subject).toBe('Active su acceso al portal de pacientes de Centro Médico Aillu');
    expect(mail.text).toContain(LINK);
    expect(mail.text).toContain('7 días');
    expect(mail.html).toContain(`href="${LINK}"`);
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toMatch(CLINICAL_WORDS);
    }
  });

  it('puts the code alone on its line, with its life, and no link to follow', () => {
    const mail = renderPortalCodeEmail({
      organizationName: ORGANIZATION,
      code: '048213',
      expiresInMinutes: 10,
      registration: false,
    });

    expect(mail.text.split('\n')).toContain('048213');
    expect(mail.text).toContain('10 minutos');
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).toContain('048213');
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toMatch(CLINICAL_WORDS);
    }
  });

  it('says in the registration code that it is to activate the access, not to sign in', () => {
    const registration = renderPortalCodeEmail({
      organizationName: ORGANIZATION,
      code: '111222',
      expiresInMinutes: 10,
      registration: true,
    });
    const signIn = renderPortalCodeEmail({
      organizationName: ORGANIZATION,
      code: '111222',
      expiresInMinutes: 10,
      registration: false,
    });

    expect(registration.subject).toContain('Active su acceso');
    expect(signIn.subject).toContain('Ingrese');
    expect(registration.subject).not.toBe(signIn.subject);
  });

  it('escapes the name of the organization in the html', () => {
    const mail = renderPortalCodeEmail({
      organizationName: '<b>Clínica</b> & Co',
      code: '123456',
      expiresInMinutes: 10,
      registration: false,
    });

    expect(mail.html).toContain('&lt;b&gt;Clínica&lt;/b&gt; &amp; Co');
    expect(mail.html).not.toContain('<b>Clínica</b>');
  });

  it.each([
    ['document_available', 'documento'],
    ['consent_request', 'documento'],
  ] as const)(
    'tells only that something waits in the portal (%s) and links to the authenticated portal',
    (kind, word) => {
      const mail = renderPortalNoticeEmail({ organizationName: ORGANIZATION, kind, link: LINK });

      expect(mail.text).toContain(word);
      expect(mail.text).toContain(LINK);
      for (const part of [mail.subject, mail.text, mail.html]) {
        expect(part).not.toMatch(CLINICAL_WORDS);
      }
    },
  );

  it('refuses a link that is not a web link', () => {
    expect(() =>
      renderPortalInvitationEmail({
        organizationName: ORGANIZATION,
        link: 'javascript:alert(1)',
        expiresInDays: 7,
      }),
    ).toThrow(/http/);
  });

  it.each([
    [{ email: true, birthDate: false }, 'datos de contacto', 'nacimiento'],
    [{ email: false, birthDate: true }, 'datos de nacimiento', 'contacto'],
    [{ email: true, birthDate: true }, 'datos de contacto y de nacimiento', 'nada'],
  ] as const)(
    'tells the address of a record that its data changed (%j), with no link and no value (JD-S5 R2-2)',
    (fields, said, notSaid) => {
      const mail = renderPortalSecurityNoticeEmail({
        organizationName: ORGANIZATION,
        kind: 'record_changed',
        fields,
      });

      expect(mail.subject).toBe(`Se modificaron datos de su ficha en ${ORGANIZATION}`);
      expect(mail.text).toContain(`Se modificaron ${said} en su ficha de ${ORGANIZATION}`);
      if (notSaid !== 'nada') expect(mail.text).not.toContain(notSaid);
      for (const part of [mail.subject, mail.text, mail.html]) {
        expect(part).not.toMatch(/https?:/);
        expect(part).not.toMatch(CLINICAL_WORDS);
      }
    },
  );
});
