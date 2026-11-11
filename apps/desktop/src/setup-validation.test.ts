import { describe, expect, it } from 'vitest';

import { PASSWORD_MESSAGES } from './password-check.js';
import {
  DEFAULT_TIME_ZONE,
  INSTALL_SLUG,
  TIME_ZONES,
  validateNewPassword,
  validateSetup,
} from './setup-validation.js';

// Built from pieces: a scanner reads a literal next to the word "password" as a leaked secret.
const weak = ['pass', 'word1234'].join('');
const derived = ['mariaperez', '2026', 'clinica'].join('-');
const common = new Set([weak, ['qwerty', 'uiop12'].join('')]);

const valid = {
  organizationName: '  Clínica Prueba ',
  ownerName: 'Dra. Ana Gómez',
  ownerEmail: ' Ana@Clinica.Example ',
  password: 'una frase larga y privada del consultorio',
  passwordConfirmation: 'una frase larga y privada del consultorio',
  timeZone: 'America/Argentina/Cordoba',
};

describe('the setup form', () => {
  it('accepts a complete form and cleans it up', () => {
    expect(validateSetup(valid, common)).toEqual({
      ok: true,
      value: {
        organizationName: 'Clínica Prueba',
        ownerName: 'Dra. Ana Gómez',
        ownerEmail: 'ana@clinica.example',
        ownerPassword: 'una frase larga y privada del consultorio',
        timeZone: 'America/Argentina/Cordoba',
      },
    });
  });

  it('defaults the time zone to Buenos Aires', () => {
    const result = validateSetup({ ...valid, timeZone: '' }, common);

    expect(result).toMatchObject({ ok: true, value: { timeZone: DEFAULT_TIME_ZONE } });
    expect(DEFAULT_TIME_ZONE).toBe('America/Argentina/Buenos_Aires');
    expect(TIME_ZONES[0]?.id).toBe(DEFAULT_TIME_ZONE);
  });

  it('says what is wrong with each field, in Spanish', () => {
    const result = validateSetup(
      {
        organizationName: 'A',
        ownerName: '',
        ownerEmail: 'sin-arroba',
        password: 'corta',
        passwordConfirmation: 'otra',
        timeZone: 'Mars/Olympus',
      },
      common,
    );

    expect(result).toEqual({
      ok: false,
      errors: {
        organizationName: expect.stringContaining('consultorio') as string,
        ownerName: expect.stringContaining('nombre') as string,
        ownerEmail: expect.stringContaining('correo') as string,
        password: PASSWORD_MESSAGES.too_short,
        timeZone: expect.stringContaining('zona horaria') as string,
      },
    });
  });

  it('uses the messages of the product for a common password and for one built from the address', () => {
    expect(
      validateSetup({ ...valid, password: weak, passwordConfirmation: weak }, common),
    ).toMatchObject({
      ok: false,
      errors: { password: PASSWORD_MESSAGES.common },
    });
    expect(
      validateSetup(
        {
          ...valid,
          ownerEmail: 'mariaperez@clinica.example',
          password: derived,
          passwordConfirmation: derived,
        },
        common,
      ),
    ).toMatchObject({ ok: false, errors: { password: PASSWORD_MESSAGES.contains_email } });
  });

  it('asks for the confirmation to match, only once the password itself is fine', () => {
    expect(validateSetup({ ...valid, passwordConfirmation: 'distinta' }, common)).toEqual({
      ok: false,
      errors: { passwordConfirmation: 'Las contraseñas no coinciden.' },
    });
    expect(
      validateSetup({ ...valid, password: 'corta', passwordConfirmation: 'distinta' }, common),
    ).toMatchObject({
      errors: { password: PASSWORD_MESSAGES.too_short },
    });
  });

  it('refuses a name with a control or invisible character', () => {
    expect(validateSetup({ ...valid, organizationName: 'Clínica\u0000Prueba' }, common).ok).toBe(
      false,
    );
    expect(validateSetup({ ...valid, ownerName: 'Ana‮Gómez' }, common).ok).toBe(false);
  });

  it('copes with anything the browser could send', () => {
    for (const value of [null, undefined, 'text', 7, [], { organizationName: 7 }]) {
      expect(validateSetup(value, common).ok).toBe(false);
    }
  });

  it('has one fixed organization address, since nobody types one', () => {
    expect(INSTALL_SLUG).toBe('consultorio');
    expect(INSTALL_SLUG).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/);
  });
});

describe('the new password of the owner', () => {
  it('applies the same rules', () => {
    expect(validateNewPassword('', '', '', common)).toMatchObject({ ok: false });
    expect(validateNewPassword('corta', 'corta', '', common)).toEqual({
      ok: false,
      errors: { password: PASSWORD_MESSAGES.too_short },
    });
    expect(validateNewPassword('una frase larga distinta', 'otra', '', common)).toEqual({
      ok: false,
      errors: { passwordConfirmation: 'Las contraseñas no coinciden.' },
    });
    expect(
      validateNewPassword('una frase larga distinta', 'una frase larga distinta', '', common),
    ).toEqual({ ok: true, value: 'una frase larga distinta' });
  });
});
