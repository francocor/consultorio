import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EXIT, runCommand, type CommandIo } from './index.js';

/**
 * `provision` and `reset-password` take over an organization, so they exist only in the desktop profile:
 * a hosted deployment that is given the command by mistake (or by someone with its environment) must
 * refuse before it opens the database.
 */
const UNREACHABLE_DATABASE = 'postgres://app_rw:x@127.0.0.1:1/none';

function hostedSingle(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    DEPLOYMENT_MODE: 'single',
    SINGLE_TENANT_SLUG: 'una-clinica',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: UNREACHABLE_DATABASE,
    KMS_PROVIDER: 'local',
    KMS_LOCAL_KEK_BASE64: randomBytes(32).toString('base64'),
    ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
  };
}

function run(name: 'provision' | 'reset-password', env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CommandIo = {
    env,
    args: [],
    readStdin: () => Promise.resolve(''),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return runCommand(name, io).then((code) => ({
    code,
    stdout: out.join(''),
    stderr: err.join(''),
  }));
}

describe('the commands that take over an organization', () => {
  it('refuse to run outside the desktop profile, before they touch the database', async () => {
    const provision = await run('provision', {
      ...hostedSingle(),
      PROVISION_ORGANIZATION_NAME: 'Clínica Norte',
      PROVISION_OWNER_NAME: 'Dra. Ana Gómez',
      PROVISION_OWNER_EMAIL: 'ana@clinica.example',
      PROVISION_OWNER_PASSWORD: 'una frase larga y privada del consultorio',
    });
    const reset = await run('reset-password', {
      ...hostedSingle(),
      RESET_NEW_PASSWORD: 'otra frase larga para entrar de nuevo',
    });

    for (const result of [provision, reset]) {
      // Exit 3 (not 1): the database was never tried, which an unreachable address would have shown.
      expect(result.code).toBe(EXIT.config);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('DEPLOYMENT_PROFILE');
      expect(result.stderr).not.toContain('frase larga');
    }
  });
});
