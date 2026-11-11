import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The API's own policy and the web app's own words: the tests below compare the shell with both.
import {
  createPasswordPolicy,
  describePasswordIssues,
  parseCommonPasswords as parseWithApi,
} from '../../api/src/modules/identity/domain/password-policy.js';

import {
  checkPassword,
  messagesForIssues,
  parseCommonPasswords,
  PASSWORD_MESSAGES,
} from './password-check.js';

const list = readFileSync(
  fileURLToPath(new URL('../../api/assets/common-passwords-100k.txt', import.meta.url)),
  'utf8',
);
const common = parseCommonPasswords(list);
const apiPolicy = createPasswordPolicy(parseWithApi(list));

const cases: [string, string][] = [
  ['corta', 'ana@clinica.example'],
  ['x'.repeat(129), 'ana@clinica.example'],
  ['a'.repeat(12), 'ana@clinica.example'],
  ['password1234', 'ana@clinica.example'],
  ['Password1234', 'ana@clinica.example'],
  ['qwertyuiop12', 'ana@clinica.example'],
  ['mariaperez-clinica', 'mariaperez@clinica.example'],
  ['una frase larga y privada del consultorio', 'ana@clinica.example'],
  ['  una frase larga y privada  ', 'ana@clinica.example'],
  ['contraseña con eñe y tildes áéí', 'luis@sur.example'],
  ['12345678901234567890', 'x@y.example'],
  ['luis-paz-2026-correcta', 'luis.paz@sur.example'],
];

describe('the password rules in the setup screen', () => {
  it('give the same verdict as the API policy', () => {
    expect(common.size).toBeGreaterThan(50_000);

    for (const [password, email] of cases) {
      const expected = apiPolicy.check(password, { email });
      expect(checkPassword(password, email, common), password).toEqual(
        expected.ok ? [] : expected.issues,
      );
    }
  });

  it('use the words of the API for every reason', () => {
    for (const described of describePasswordIssues(Object.keys(PASSWORD_MESSAGES) as never)) {
      // The API's es-AR text uses "tu"; the product web app uses "usted". The numbers must agree.
      expect(PASSWORD_MESSAGES[described.code].replace(/\D+/g, ' ')).toBe(
        described.message.replace(/\D+/g, ' '),
      );
    }
  });

  it('use exactly the words of the web app, which is what the owner sees everywhere else', () => {
    const locale = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../web/src/locales/es-AR/auth.json', import.meta.url)),
        'utf8',
      ),
    ) as Record<string, string>;

    for (const [issue, message] of Object.entries(PASSWORD_MESSAGES)) {
      expect(locale[`password.${issue}`], issue).toBe(message);
    }
  });

  it('turn the reasons the API reports into messages, and skip one it does not know', () => {
    expect(messagesForIssues(['too_short', 'something_new', 'common'])).toEqual([
      PASSWORD_MESSAGES.too_short,
      PASSWORD_MESSAGES.common,
    ]);
  });
});
