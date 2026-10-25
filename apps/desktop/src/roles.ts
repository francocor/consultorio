/**
 * `infra/postgres/init/01-roles.sql` ships with public development passwords. On a clinic PC every login
 * gets a random one, and the two logins the desktop never uses (`app_operator`, `app_releaser`) cannot
 * log in at all. The script is changed by replacing exactly the lines that carry those passwords, and the
 * change fails loudly if the script ever stops looking the way this expects: a script that quietly kept a
 * development password would be a backdoor on a medical database.
 */

export interface RolePasswords {
  appOwner: string;
  appRw: string;
  auditSealer: string;
}

/** Letters, digits, `-` and `_`: safe inside an SQL literal and a URL without escaping. */
const SAFE_PASSWORD = /^[A-Za-z0-9_-]{24,}$/;

const KEPT_LOGINS = [
  ['app_owner', 'appOwner'],
  ['app_rw', 'appRw'],
  ['audit_sealer', 'auditSealer'],
] as const;
const DISABLED_LOGINS = ['app_operator', 'app_releaser'] as const;

function replaceOnce(script: string, search: string, replacement: string, what: string): string {
  const first = script.indexOf(search);
  if (first === -1 || script.indexOf(search, first + search.length) !== -1) {
    throw new Error(`01-roles.sql does not have exactly one ${what}`);
  }
  return script.slice(0, first) + replacement + script.slice(first + search.length);
}

export function parameterizeRolesScript(script: string, passwords: RolePasswords): string {
  let result = script;
  for (const [role, key] of KEPT_LOGINS) {
    const password = passwords[key];
    if (!SAFE_PASSWORD.test(password)) throw new Error(`The password of ${role} is not usable`);
    result = replaceOnce(
      result,
      `PASSWORD '${role}_dev_only'`,
      `PASSWORD '${password}'`,
      `password line of ${role}`,
    );
  }
  for (const role of DISABLED_LOGINS) {
    result = replaceOnce(
      result,
      `LOGIN PASSWORD '${role}_dev_only'`,
      'NOLOGIN',
      `login line of ${role}`,
    );
  }
  if (result.includes('_dev_only')) {
    throw new Error('01-roles.sql still has a development password');
  }
  return result;
}
