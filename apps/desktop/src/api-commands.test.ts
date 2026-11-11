import { describe, expect, it } from 'vitest';

import { ApiCommandError, createApiCommands, EXIT } from './api-commands.js';
import type { RunOptions, RunResult, Runner } from './runner.js';

interface Call {
  file: string;
  args: string[];
  options: RunOptions | undefined;
}

function fakeRunner(answers: Partial<RunResult>[]): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = (file, args, options) => {
    calls.push({ file, args, options });
    const answer = answers.shift() ?? {};
    return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...answer });
  };
  return { runner, calls };
}

const options = (runner: Runner) => ({
  runner,
  nodeExe: 'C:\\Consulvia\\Consulvia.exe',
  mainJs: 'C:\\Consulvia\\resources\\api\\dist\\main.js',
  cwd: 'C:\\Consulvia\\resources\\api',
});

const owner = {
  organizationName: 'Clínica Prueba',
  ownerName: 'Dra. Ana Gómez',
  ownerEmail: 'ana@clinica.example',
  ownerPassword: 'una frase larga y privada del consultorio',
  timeZone: 'America/Argentina/Buenos_Aires',
};

describe('the commands of the API bundle', () => {
  it('runs them as node (ELECTRON_RUN_AS_NODE) from the folder of the bundle', async () => {
    const { runner, calls } = fakeRunner([
      { stdout: 'migrations applied\nplatform catalogs loaded\n' },
    ]);

    const output = await createApiCommands(options(runner)).migrate({ A: '1' });

    expect(output).toContain('platform catalogs loaded');
    expect(calls[0]).toMatchObject({
      file: 'C:\\Consulvia\\Consulvia.exe',
      args: ['C:\\Consulvia\\resources\\api\\dist\\main.js', 'migrate'],
      options: { cwd: 'C:\\Consulvia\\resources\\api', env: { A: '1', ELECTRON_RUN_AS_NODE: '1' } },
    });
  });

  it('sends the password on the standard input, never in an argument or the environment', async () => {
    const { runner, calls } = fakeRunner([
      { stdout: '{"result":"created","tenantId":"0190-aa","slug":"consultorio"}\n' },
    ]);

    const result = await createApiCommands(options(runner)).provision(
      { NODE_ENV: 'production' },
      owner,
    );

    expect(result).toEqual({ result: 'created', tenantId: '0190-aa', slug: 'consultorio' });
    const [call] = calls;
    expect(call?.args).toEqual([expect.stringContaining('main.js'), 'provision', '--stdin']);
    expect(JSON.parse(call?.options?.input ?? '')).toEqual(owner);
    expect(JSON.stringify(call?.args)).not.toContain(owner.ownerPassword);
    expect(JSON.stringify(call?.options?.env)).not.toContain(owner.ownerPassword);
  });

  it('asks reset-password to clear the second factor only when told to', async () => {
    const { runner, calls } = fakeRunner([
      {
        stdout:
          '{"result":"reset","email":"ana@clinica.example","secondFactorCleared":true,"ownerNotified":true}\n',
      },
    ]);

    const result = await createApiCommands(options(runner)).resetPassword(
      {},
      { newPassword: 'otra frase larga para entrar', clearSecondFactor: true },
    );

    expect(result).toEqual({
      email: 'ana@clinica.example',
      secondFactorCleared: true,
      ownerNotified: true,
    });
    expect(JSON.parse(calls[0]?.options?.input ?? '')).toEqual({
      newPassword: 'otra frase larga para entrar',
      clearSecondFactor: true,
    });
  });

  it('turns exit 2 with a rejected password into an error that names the reasons', async () => {
    const { runner } = fakeRunner([
      {
        code: EXIT.invalidInput,
        stderr: '{"error":"password_rejected","issues":["too_short","common"]}\n',
      },
    ]);

    const failure = await createApiCommands(options(runner))
      .provision({}, owner)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiCommandError);
    expect(failure).toMatchObject({
      exitCode: EXIT.invalidInput,
      reason: 'password_rejected',
      passwordIssues: ['too_short', 'common'],
    });
  });

  it('turns exit 2 with invalid fields into an error that names the fields', async () => {
    const { runner } = fakeRunner([
      { code: EXIT.invalidInput, stderr: '{"error":"invalid_input","fields":["ownerEmail"]}\n' },
    ]);

    const failure = await createApiCommands(options(runner))
      .provision({}, owner)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ reason: 'invalid_input', fields: ['ownerEmail'] });
  });

  it('keeps going when the standard error is not JSON (an unexpected crash)', async () => {
    const { runner } = fakeRunner([{ code: 1, stderr: 'Error: boom\n    at x\n' }]);

    const failure = await createApiCommands(options(runner))
      .migrate({})
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ exitCode: 1, body: null, reason: null });
    expect((failure as ApiCommandError).stderr).toContain('boom');
  });

  it('does not trust an answer that is not what the contract says', async () => {
    const { runner } = fakeRunner([{ stdout: '{"result":"maybe"}\n' }]);

    await expect(createApiCommands(options(runner)).provision({}, owner)).rejects.toBeInstanceOf(
      ApiCommandError,
    );
  });
});
