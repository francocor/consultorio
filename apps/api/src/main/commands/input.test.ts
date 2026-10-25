import { describe, expect, it } from 'vitest';

import { DEFAULT_TIME_ZONE, readProvisionInput, readResetInput } from './input.js';

const provisionEnv = {
  PROVISION_ORGANIZATION_NAME: 'Clínica Norte',
  PROVISION_OWNER_NAME: 'Dra. Ana Gómez',
  PROVISION_OWNER_EMAIL: ' Ana@Clinica.Example ',
  PROVISION_OWNER_PASSWORD: 'una frase larga y privada del consultorio',
};

describe('the input of the provision command', () => {
  it('reads the environment, trims and lower-cases what it should, and defaults the time zone', () => {
    const read = readProvisionInput({ env: provisionEnv });

    expect(read).toEqual({
      ok: true,
      value: {
        organizationName: 'Clínica Norte',
        ownerName: 'Dra. Ana Gómez',
        ownerEmail: 'ana@clinica.example',
        ownerPassword: 'una frase larga y privada del consultorio',
        timeZone: DEFAULT_TIME_ZONE,
      },
    });
    expect(DEFAULT_TIME_ZONE).toBe('America/Argentina/Buenos_Aires');
  });

  it('reads a JSON document from the standard input instead, which wins over the environment', () => {
    const read = readProvisionInput({
      env: provisionEnv,
      stdin: JSON.stringify({
        organizationName: 'Consultorio Sur',
        ownerName: 'Dr. Luis Paz',
        ownerEmail: 'luis@sur.example',
        ownerPassword: 'otra frase larga y privada de prueba',
        timeZone: 'America/Argentina/Cordoba',
        slug: 'consultorio-sur',
      }),
    });

    expect(read).toMatchObject({
      ok: true,
      value: {
        organizationName: 'Consultorio Sur',
        ownerEmail: 'luis@sur.example',
        timeZone: 'America/Argentina/Cordoba',
        slug: 'consultorio-sur',
      },
    });
  });

  it('names the fields that are missing or wrong and never prints a value', () => {
    const read = readProvisionInput({
      env: {
        ...provisionEnv,
        PROVISION_OWNER_EMAIL: 'not-an-address-secret-value',
        PROVISION_OWNER_PASSWORD: undefined,
        PROVISION_TIME_ZONE: 'Mars/Olympus',
      },
    });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.fields.sort()).toEqual(['ownerEmail', 'ownerPassword', 'timeZone']);
    expect(JSON.stringify(read)).not.toContain('secret-value');
  });

  it.each([
    ['an organization name with a line break', { PROVISION_ORGANIZATION_NAME: 'Clínica\nNorte' }],
    ['an organization name of one character', { PROVISION_ORGANIZATION_NAME: 'C' }],
    ['an owner name with a hidden character', { PROVISION_OWNER_NAME: 'Ana‮Gómez' }],
    ['an empty password', { PROVISION_OWNER_PASSWORD: '' }],
  ])('refuses %s', (_name, change) => {
    const read = readProvisionInput({ env: { ...provisionEnv, ...change } });

    expect(read.ok).toBe(false);
  });

  it('refuses a document that is not JSON, or has keys it does not know', () => {
    expect(readProvisionInput({ env: {}, stdin: 'not json' })).toEqual({
      ok: false,
      fields: ['(input)'],
    });
    expect(readProvisionInput({ env: {}, stdin: '[]' })).toEqual({
      ok: false,
      fields: ['(input)'],
    });
    const extra = readProvisionInput({
      env: {},
      stdin: JSON.stringify({ ...{ organizationName: 'X' }, surprise: 1 }),
    });
    expect(extra.ok).toBe(false);
  });

  it('does not read the password from anywhere but the environment or the document', () => {
    const read = readProvisionInput({
      env: { ...provisionEnv, PROVISION_OWNER_PASSWORD: undefined },
    });

    expect(read.ok).toBe(false);
  });
});

describe('the input of the reset-password command', () => {
  it('reads the new password from the environment, and the address of the owner if it is given', () => {
    expect(readResetInput({ env: { RESET_NEW_PASSWORD: 'otra frase larga para entrar' } })).toEqual(
      {
        ok: true,
        value: { newPassword: 'otra frase larga para entrar', clearSecondFactor: false },
      },
    );
    expect(
      readResetInput({
        env: {
          RESET_NEW_PASSWORD: 'otra frase larga para entrar',
          RESET_OWNER_EMAIL: 'Ana@Clinica.Example',
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        newPassword: 'otra frase larga para entrar',
        ownerEmail: 'ana@clinica.example',
        clearSecondFactor: false,
      },
    });
  });

  it('removes the second factor only when asked to, from the environment or from the document', () => {
    const base = { RESET_NEW_PASSWORD: 'otra frase larga para entrar' };

    for (const yes of ['true', '1']) {
      expect(readResetInput({ env: { ...base, RESET_CLEAR_SECOND_FACTOR: yes } })).toMatchObject({
        ok: true,
        value: { clearSecondFactor: true },
      });
    }
    for (const no of ['false', '0', '']) {
      expect(readResetInput({ env: { ...base, RESET_CLEAR_SECOND_FACTOR: no } })).toMatchObject({
        ok: true,
        value: { clearSecondFactor: false },
      });
    }
    expect(
      readResetInput({
        env: {},
        stdin: JSON.stringify({
          newPassword: 'otra frase larga para entrar',
          clearSecondFactor: true,
        }),
      }),
    ).toMatchObject({ ok: true, value: { clearSecondFactor: true } });
  });

  it('refuses a second-factor flag that is neither a yes nor a no', () => {
    expect(
      readResetInput({
        env: {
          RESET_NEW_PASSWORD: 'otra frase larga para entrar',
          RESET_CLEAR_SECOND_FACTOR: 'maybe',
        },
      }),
    ).toEqual({ ok: false, fields: ['clearSecondFactor'] });
  });

  it('reads a JSON document from the standard input', () => {
    expect(
      readResetInput({
        env: {},
        stdin: JSON.stringify({ newPassword: 'otra frase larga para entrar' }),
      }),
    ).toMatchObject({ ok: true, value: { newPassword: 'otra frase larga para entrar' } });
  });

  it('needs a new password and a valid address when one is given', () => {
    expect(readResetInput({ env: {} })).toEqual({ ok: false, fields: ['newPassword'] });
    expect(
      readResetInput({ env: { RESET_NEW_PASSWORD: 'x'.repeat(20), RESET_OWNER_EMAIL: 'no' } }),
    ).toEqual({ ok: false, fields: ['ownerEmail'] });
  });
});
