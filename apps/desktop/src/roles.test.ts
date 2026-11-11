import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parameterizeRolesScript } from './roles.js';

// The real script of the repository: if it ever changes shape, this fails here and not on a clinic's PC.
const script = readFileSync(
  fileURLToPath(new URL('../../../infra/postgres/init/01-roles.sql', import.meta.url)),
  'utf8',
);

const passwords = {
  appOwner: 'o'.repeat(43),
  appRw: 'w'.repeat(43),
  auditSealer: 's'.repeat(43),
};

describe('the role script of a clinic PC', () => {
  it('gives each login the random password and leaves no development password', () => {
    const result = parameterizeRolesScript(script, passwords);

    expect(result).not.toContain('_dev_only');
    expect(result).toContain(`CREATE ROLE app_owner LOGIN PASSWORD '${passwords.appOwner}'`);
    expect(result).toContain(`CREATE ROLE app_rw LOGIN PASSWORD '${passwords.appRw}'`);
    expect(result).toContain(`CREATE ROLE audit_sealer LOGIN PASSWORD '${passwords.auditSealer}'`);
  });

  it('makes the operator and the releaser unable to log in', () => {
    const result = parameterizeRolesScript(script, passwords);

    expect(result).toContain('CREATE ROLE app_operator NOLOGIN');
    expect(result).toContain('CREATE ROLE app_releaser NOLOGIN');
    expect(result).not.toMatch(/app_operator LOGIN/);
    expect(result).not.toMatch(/app_releaser LOGIN/);
  });

  it('changes nothing else: the grants and the ownership stay as the repository wrote them', () => {
    const result = parameterizeRolesScript(script, passwords);

    expect(result).toContain(
      'GRANT audit_sealer TO app_rw WITH INHERIT FALSE, SET TRUE GRANTED BY app_owner',
    );
    expect(result).toContain(
      "EXECUTE format('ALTER DATABASE %I OWNER TO app_owner', current_database())",
    );
    expect(result.split('\n').length).toBe(script.split('\n').length);
  });

  it('refuses a password that is not safe in a literal or a URL', () => {
    expect(() =>
      parameterizeRolesScript(script, { ...passwords, appRw: "x'; DROP ROLE app_owner; --" }),
    ).toThrow(/not usable/);
    expect(() => parameterizeRolesScript(script, { ...passwords, appRw: 'short' })).toThrow(
      /not usable/,
    );
  });

  it('fails loudly when the script no longer looks the way this expects', () => {
    expect(() =>
      parameterizeRolesScript(script.replace("'app_rw_dev_only'", "'something_else'"), passwords),
    ).toThrow(/exactly one password line of app_rw/);
    expect(() =>
      parameterizeRolesScript(
        `${script}\nALTER ROLE app_rw PASSWORD 'app_rw_dev_only';`,
        passwords,
      ),
    ).toThrow(/exactly one password line of app_rw/);
    expect(() => parameterizeRolesScript(`${script}\n-- 'app_rw_dev_only'`, passwords)).toThrow(
      /development password/,
    );
    expect(() =>
      parameterizeRolesScript(
        `${script}\nCREATE ROLE extra LOGIN PASSWORD 'extra_dev_only';`,
        passwords,
      ),
    ).toThrow(/development password/);
  });
});
