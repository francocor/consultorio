import { describe, expect, it } from 'vitest';

import {
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderProfessionalAddedEmail,
} from './templates.js';

const LINK = 'https://clinica-sur.consultorio.test/auth/reset?token=abc_DEF-123';

describe('password reset email (es-AR)', () => {
  it('speaks in neutral Spanish, never in voseo', () => {
    const email = renderPasswordResetEmail({
      organizationName: 'Clínica Sur',
      link: LINK,
      expiresInMinutes: 30,
    });

    expect(email.text + email.html).not.toMatch(
      /\b(restablecé|abrí|elegí|ignorá|copiá|pediste)\b/i,
    );
  });

  it('names the organization, carries the link and says how long it lasts', () => {
    const email = renderPasswordResetEmail({
      organizationName: 'Clínica Sur',
      link: LINK,
      expiresInMinutes: 30,
    });

    expect(email.subject).toBe('Restablezca su contraseña de Clínica Sur');
    expect(email.text).toContain(LINK);
    expect(email.text).toContain('30 minutos');
    expect(email.text).toContain('Si no hizo este pedido');
    expect(email.html).toContain(`href="${LINK}"`);
    expect(email.html).toContain('30 minutos');
  });

  it('puts the link once in the text and never a password', () => {
    const email = renderPasswordResetEmail({
      organizationName: 'Clínica Sur',
      link: LINK,
      expiresInMinutes: 30,
    });

    expect(email.text.split(LINK)).toHaveLength(2);
    expect(email.text.toLowerCase()).not.toContain('su contraseña es');
  });

  it('escapes the organization name in the HTML (no markup injection)', () => {
    const email = renderPasswordResetEmail({
      organizationName: '<img src=x onerror=alert(1)> & Co',
      link: LINK,
      expiresInMinutes: 30,
    });

    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; Co');
    expect(email.subject).toContain('<img src=x onerror=alert(1)> & Co');
  });

  it('refuses a link that is not http(s)', () => {
    expect(() =>
      renderPasswordResetEmail({
        organizationName: 'X',
        link: 'javascript:alert(1)',
        expiresInMinutes: 30,
      }),
    ).toThrow(/link/);
  });

  it('uses the singular for a lifetime of one minute and hours for longer ones', () => {
    const one = renderPasswordResetEmail({
      organizationName: 'X',
      link: LINK,
      expiresInMinutes: 1,
    });
    const hours = renderPasswordResetEmail({
      organizationName: 'X',
      link: LINK,
      expiresInMinutes: 120,
    });

    expect(one.text).toContain('1 minuto.');
    expect(hours.text).toContain('2 horas');
  });
});

describe('staff invitation email (es-AR)', () => {
  it('invites to the organization, with who invited and the link', () => {
    const email = renderInvitationEmail({
      organizationName: 'Clínica Sur',
      inviterName: 'Ana Pérez',
      link: LINK,
      expiresInDays: 7,
    });

    expect(email.subject).toBe('Invitación para unirse a Clínica Sur');
    expect(email.text).toContain('Ana Pérez');
    expect(email.text).toContain(LINK);
    expect(email.text).toContain('7 días');
    expect(email.text).toContain('elegir su contraseña');
    expect(email.text).toContain('La invitación la envió Ana Pérez');
    expect(email.html).toContain(`href="${LINK}"`);
  });

  it('works without a named inviter', () => {
    const email = renderInvitationEmail({
      organizationName: 'Clínica Sur',
      link: LINK,
      expiresInDays: 1,
    });

    expect(email.text).toContain('Recibió una invitación para unirse a Clínica Sur.');
    expect(email.text).toContain('1 día.');
    expect(email.text).not.toContain('undefined');
  });

  it('escapes names in the HTML', () => {
    const email = renderInvitationEmail({
      organizationName: 'A & B',
      inviterName: '<b>Eve</b>',
      link: LINK,
      expiresInDays: 7,
    });

    expect(email.html).not.toContain('<b>Eve</b>');
    expect(email.html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(email.html).toContain('A &amp; B');
  });
});

describe('professional added by an admin email (es-AR, decision D19)', () => {
  const STAFF = 'https://clinica-sur.consultorio.test/staff';

  it('tells the owner who added a professional, by invitation, in neutral Spanish', () => {
    const email = renderProfessionalAddedEmail({
      organizationName: 'Clínica Sur',
      adminName: 'Laura Pérez',
      subjectName: 'Dra. Ana Gómez',
      via: 'invitation',
      link: STAFF,
    });

    expect(email.subject).toBe('Un administrador incorporó a un profesional en Clínica Sur');
    expect(email.text).toContain('Laura Pérez');
    expect(email.text).toContain('Dra. Ana Gómez');
    expect(email.text).toContain('invitó');
    expect(email.text).toContain(STAFF);
    expect(email.html).toContain(`href="${STAFF}"`);
    expect(email.text + email.html).not.toMatch(/\b(revisá|entrá|fijate|mirá)\b/i);
  });

  it('says it was a role grant, and copes with no names', () => {
    const email = renderProfessionalAddedEmail({
      organizationName: 'Clínica Sur',
      via: 'role_grant',
      link: STAFF,
    });

    expect(email.text).toContain('rol de profesional');
    expect(email.text).toContain('Un administrador');
    expect(email.text).not.toContain('undefined');
  });

  it('escapes names in the HTML', () => {
    const email = renderProfessionalAddedEmail({
      organizationName: 'Clínica Sur',
      adminName: '<b>x</b>',
      subjectName: '<i>y</i>',
      via: 'invitation',
      link: STAFF,
    });

    expect(email.html).not.toContain('<b>x</b>');
    expect(email.html).not.toContain('<i>y</i>');
  });

  it('refuses a link that is not http(s)', () => {
    expect(() =>
      renderProfessionalAddedEmail({
        organizationName: 'Clínica Sur',
        via: 'role_grant',
        link: 'javascript:alert(1)',
      }),
    ).toThrow();
  });
});
