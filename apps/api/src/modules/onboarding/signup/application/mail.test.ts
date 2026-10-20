import { describe, expect, it } from 'vitest';

import { renderExistingAccountEmail, renderVerificationEmail } from './mail.js';

const link = 'https://centro.consultorio.test/signup/verify?token=abc';

describe('the verification email', () => {
  it('greets the owner, names the organization, carries the link and says how long it lasts', () => {
    const mail = renderVerificationEmail({
      ownerName: 'Ana Pérez',
      organizationName: 'Centro Norte',
      link,
      expiresInHours: 24,
    });

    expect(mail.subject).toBe('Confirme su correo para activar su organización');
    expect(mail.text).toContain('Hola, Ana Pérez.');
    expect(mail.text).toContain('"Centro Norte"');
    expect(mail.text).toContain(link);
    expect(mail.text).toContain('vence en 24 horas');
    expect(mail.html).toContain('lang="es-AR"');
    expect(mail.html).toContain(`href="${link}"`);
  });

  it('escapes what the visitor typed in the HTML, so a name cannot add markup to the email', () => {
    const mail = renderVerificationEmail({
      ownerName: '<img src=x onerror=alert(1)>',
      organizationName: '"><script>alert(1)</script>',
      link,
      expiresInHours: 1,
    });

    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.text).toContain('vence en 1 hora.');
  });

  it('refuses a link that is not a web address', () => {
    for (const bad of ['javascript:alert(1)', 'ftp://x/y', 'https://x/"onmouseover="y', '']) {
      expect(() =>
        renderVerificationEmail({
          ownerName: 'Ana',
          organizationName: 'Centro',
          link: bad,
          expiresInHours: 24,
        }),
      ).toThrow(/http/);
    }
  });
});

describe('the notice to the holder of an account', () => {
  it('says that nothing was created, links nowhere and names nobody', () => {
    const mail = renderExistingAccountEmail();

    expect(mail.subject).toBe('Alguien pidió crear una organización con su correo');
    expect(mail.text).toContain('No se creó ni se modificó nada');
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toMatch(/<a /);
    expect(mail.html).toContain('lang="es-AR"');
  });
});
