import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { runCommand, EXIT, type CommandIo } from '../../src/main/commands/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * The commands the desktop shell runs through `main.js` (provision, reset-password, migrate), at the
 * level the shell sees them: environment and standard input in, exit code and two streams out. The
 * password never appears in either stream.
 */
let runtime: DbHandle;
let counter = 0;

const PASSWORD = 'una frase larga y privada del consultorio';
const ORIGIN = 'http://127.0.0.1:41234';

beforeAll(() => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
});

afterAll(async () => {
  await runtime.close();
});

/** The environment the shell gives every process of an install: only the slug differs per test. */
function installEnv(slug: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DEPLOYMENT_PROFILE: 'desktop',
    DEPLOYMENT_MODE: 'single',
    SINGLE_TENANT_SLUG: slug,
    PUBLIC_URL: ORIGIN,
    PORT: '41235',
    DATABASE_URL: inject('runtimeUrl'),
    KMS_PROVIDER: 'local',
    KMS_LOCAL_KEK_BASE64: randomBytes(32).toString('base64'),
    ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
    STORAGE_DIR: process.platform === 'win32' ? 'C:\\Consulvia\\files' : '/var/consulvia/files',
    STORAGE_UPLOAD_SECRET: 'placeholder-upload-secret-0123456789-abcdef',
  };
}

function freshSlug(): string {
  counter += 1;
  return `local-cmd-${String(counter)}`;
}

function provisionEnv(slug: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...installEnv(slug),
    PROVISION_ORGANIZATION_NAME: 'Clínica Norte',
    PROVISION_OWNER_NAME: 'Dra. Ana Gómez',
    PROVISION_OWNER_EMAIL: `ana.${slug}@clinica.example`,
    PROVISION_OWNER_PASSWORD: PASSWORD,
    ...overrides,
  };
}

async function run(
  name: Parameters<typeof runCommand>[0],
  options: { env: NodeJS.ProcessEnv; args?: string[]; stdin?: string },
) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CommandIo = {
    env: options.env,
    args: options.args ?? [],
    readStdin: () => Promise.resolve(options.stdin ?? ''),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await runCommand(name, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const lastJson = (text: string) =>
  JSON.parse(text.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;

async function desktopApp(slug: string): Promise<FastifyInstance> {
  const app = buildTestApplication(runtime, {
    deployment: { mode: 'single', slug },
    cookieSecure: false,
    publicUrl: ORIGIN,
    wiring: [],
  });
  await app.ready();
  return app;
}

const signIn = async (app: FastifyInstance, email: string, password: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { host: '127.0.0.1:41234', origin: ORIGIN, 'user-agent': 'vitest-browser' },
      remoteAddress: '127.0.0.1',
      payload: { email, password },
    })
  ).statusCode;

describe('provision', () => {
  it('creates the organization from the environment, answers one JSON line, and the owner can sign in', async () => {
    const slug = freshSlug();
    const env = provisionEnv(slug);

    const result = await run('provision', { env });

    expect(result.code).toBe(EXIT.ok);
    expect(lastJson(result.stdout)).toMatchObject({ result: 'created', slug });
    expect(result.stderr).toBe('');
    const app = await desktopApp(slug);
    expect(await signIn(app, `ana.${slug}@clinica.example`, PASSWORD)).toBe(200);
    await app.close();
  });

  it('reads the input from the standard input with --stdin, and prints no password', async () => {
    const slug = freshSlug();
    const stdin = JSON.stringify({
      organizationName: 'Consultorio Sur',
      ownerName: 'Dr. Luis Paz',
      ownerEmail: `luis.${slug}@sur.example`,
      ownerPassword: PASSWORD,
      timeZone: 'America/Argentina/Cordoba',
    });

    const result = await run('provision', { env: installEnv(slug), args: ['--stdin'], stdin });

    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout + result.stderr).not.toContain(PASSWORD);
    expect(lastJson(result.stdout)).toMatchObject({ result: 'created' });
  });

  it('says the organization exists the second time, with the same exit code, and changes nothing', async () => {
    const slug = freshSlug();
    const env = provisionEnv(slug);
    const first = await run('provision', { env });

    const second = await run('provision', {
      env: provisionEnv(slug, {
        PROVISION_OWNER_PASSWORD: 'una frase totalmente distinta y larga',
      }),
    });

    expect(second.code).toBe(EXIT.ok);
    expect(lastJson(second.stdout)).toEqual({
      ...lastJson(first.stdout),
      result: 'exists',
    });
    const app = await desktopApp(slug);
    expect(await signIn(app, `ana.${slug}@clinica.example`, PASSWORD)).toBe(200);
    await app.close();
  });

  it('exits 2 and names the fields when the input is wrong, without a value', async () => {
    const slug = freshSlug();

    const result = await run('provision', {
      env: provisionEnv(slug, {
        PROVISION_OWNER_EMAIL: 'sin-arroba-valor-privado',
        PROVISION_OWNER_PASSWORD: undefined,
      }),
    });

    expect(result.code).toBe(EXIT.usage);
    expect(result.stdout).toBe('');
    const body = lastJson(result.stderr);
    expect(body['error']).toBe('invalid_input');
    expect(body['fields']).toEqual(expect.arrayContaining(['ownerEmail', 'ownerPassword']));
    expect(result.stderr).not.toContain('valor-privado');
  });

  it('exits 2 with the reasons when the password does not follow the rules, and prints nothing of it', async () => {
    const slug = freshSlug();

    const result = await run('provision', {
      env: provisionEnv(slug, { PROVISION_OWNER_PASSWORD: 'password123' }),
    });

    expect(result.code).toBe(EXIT.usage);
    expect(lastJson(result.stderr)).toMatchObject({ error: 'password_rejected' });
    expect(result.stdout + result.stderr).not.toContain('password123');
  });

  it('exits 2 when the input names another slug than the install is pinned to', async () => {
    const slug = freshSlug();

    const result = await run('provision', {
      env: provisionEnv(slug, { PROVISION_SLUG: 'otra-clinica' }),
    });

    expect(result.code).toBe(EXIT.usage);
    expect(lastJson(result.stderr)).toEqual({ error: 'invalid_input', fields: ['slug'] });
  });

  it('exits 3 when the environment is not a valid configuration, naming the variable', async () => {
    const slug = freshSlug();

    const result = await run('provision', {
      env: provisionEnv(slug, { KMS_LOCAL_KEK_BASE64: undefined }),
    });

    expect(result.code).toBe(EXIT.config);
    expect(lastJson(result.stderr)).toMatchObject({ error: 'invalid_config' });
    expect(result.stderr).toContain('KMS_LOCAL_KEK_BASE64');
  });

  it('exits 4 and changes nothing when the slug belongs to a demo organization', async () => {
    const slug = freshSlug();
    await createTestTenant(runtime, { slug, isDemo: true });

    const result = await run('provision', { env: provisionEnv(slug) });

    expect(result.code).toBe(EXIT.refused);
    expect(lastJson(result.stderr)).toEqual({ error: 'demo_organization' });
  });

  it('exits 1 when the database cannot be reached', async () => {
    const slug = freshSlug();

    const result = await run('provision', {
      env: provisionEnv(slug, { DATABASE_URL: 'postgres://app_rw:x@127.0.0.1:1/none' }),
    });

    expect(result.code).toBe(EXIT.failed);
    expect(lastJson(result.stderr)).toMatchObject({ error: 'failed' });
  });
});

describe('reset-password', () => {
  const NEW_PASSWORD = 'otra frase larga para entrar de nuevo';

  it('gives the owner a new password, from the environment or from the standard input', async () => {
    const slug = freshSlug();
    await run('provision', { env: provisionEnv(slug) });
    const email = `ana.${slug}@clinica.example`;

    const fromEnv = await run('reset-password', {
      env: { ...installEnv(slug), RESET_NEW_PASSWORD: NEW_PASSWORD },
    });
    const fromStdin = await run('reset-password', {
      env: installEnv(slug),
      args: ['--stdin'],
      stdin: JSON.stringify({ newPassword: 'y una tercera frase larga para entrar' }),
    });

    expect(fromEnv.code).toBe(EXIT.ok);
    expect(lastJson(fromEnv.stdout)).toEqual({ result: 'reset', email });
    expect(fromStdin.code).toBe(EXIT.ok);
    expect(fromEnv.stdout + fromEnv.stderr + fromStdin.stdout + fromStdin.stderr).not.toContain(
      'frase larga para entrar',
    );
    const app = await desktopApp(slug);
    expect(await signIn(app, email, PASSWORD)).toBe(401);
    expect(await signIn(app, email, NEW_PASSWORD)).toBe(401);
    expect(await signIn(app, email, 'y una tercera frase larga para entrar')).toBe(200);
    await app.close();
  });

  it('exits 2 for a password that breaks the rules, and 4 when there is no such organization', async () => {
    const slug = freshSlug();
    await run('provision', { env: provisionEnv(slug) });

    const weak = await run('reset-password', {
      env: { ...installEnv(slug), RESET_NEW_PASSWORD: 'corta' },
    });
    const missing = await run('reset-password', {
      env: { ...installEnv('no-existe-nunca'), RESET_NEW_PASSWORD: NEW_PASSWORD },
    });
    const none = await run('reset-password', { env: installEnv(slug) });

    expect(weak.code).toBe(EXIT.usage);
    expect(lastJson(weak.stderr)).toMatchObject({ error: 'password_rejected' });
    expect(missing.code).toBe(EXIT.refused);
    expect(lastJson(missing.stderr)).toEqual({ error: 'organization_not_found' });
    expect(none.code).toBe(EXIT.usage);
    expect(lastJson(none.stderr)).toEqual({ error: 'invalid_input', fields: ['newPassword'] });
  });
});

describe('migrate', () => {
  it('applies the migrations of the folder it is given and loads the catalogs, and is safe to run again', async () => {
    const env = { MIGRATION_DATABASE_URL: inject('ownerUrl') };

    const first = await run('migrate', { env });
    const again = await run('migrate', { env });

    expect(first.code).toBe(EXIT.ok);
    expect(first.stdout).toContain('migrations applied');
    expect(first.stdout).toContain('platform catalogs loaded');
    expect(again.code).toBe(EXIT.ok);
  });

  it('exits 3 without a database and with a folder that holds no migrations', async () => {
    const none = await run('migrate', { env: {} });
    const empty = await run('migrate', {
      env: { MIGRATION_DATABASE_URL: inject('ownerUrl'), MIGRATIONS_DIR: process.cwd() },
    });

    expect(none.code).toBe(EXIT.config);
    expect(none.stderr).toContain('MIGRATION_DATABASE_URL');
    expect(empty.code).toBe(EXIT.config);
    expect(empty.stderr).toContain('MIGRATIONS_DIR');
  });
});
