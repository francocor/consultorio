import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { releaserPublicKeyOf } from '../modules/tenancy/archive/archive-crypto.js';

/**
 * The production image is smoke-tested by running it with a database address nobody listens on and
 * asking `/health`: the process must start without a database (`/ready` is the database probe).
 * Anything that connects while the application is being built, such as a queue client started at
 * boot, breaks that. This test boots the real entry point the way the smoke test does.
 */

const API_DIR = fileURLToPath(new URL('../..', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** The environment of the CI smoke test (`.github/workflows/ci.yml`), plus a port of our own. */
function smokeEnv(port: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
    NODE_ENV: 'production',
    ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
    PORT: String(port),
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
    DEPLOYMENT_MODE: 'multi',
    BASE_DOMAIN: 'smoke.test',
    PLATFORM_HOST: 'platform.smoke.test',
    KMS_PROVIDER: 'aws',
    AWS_REGION: 'sa-east-1',
    AWS_KMS_KEY_ID: 'alias/smoke-test',
    SMTP_HOST: 'smtp.smoke.test',
    SMTP_SECURITY: 'starttls',
  };
}

async function untilHealthy(
  port: number,
  child: ChildProcess,
  output: () => string,
): Promise<number> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The API exited with code ${String(child.exitCode)}: ${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      return response.status;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`The API never answered /health: ${output()}`);
}

describe('booting the API without a database', () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  it('starts and answers /health with 200 while the database address is unreachable', async () => {
    const port = await freePort();
    let output = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main/main.ts', 'api'], {
      cwd: API_DIR,
      env: smokeEnv(port),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    const status = await untilHealthy(port, child, () => output);

    expect(status).toBe(200);
  }, 60_000);
});

/** Runs the entry point with a role and waits for it to stop on its own. */
function runUntilExit(role: string, extra: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    let output = '';
    const process_ = spawn(process.execPath, ['--import', 'tsx', 'src/main/main.ts', role], {
      cwd: API_DIR,
      env: { ...smokeEnv(3999), ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      process_.kill();
      reject(new Error(`The ${role} role did not stop: ${output}`));
    }, 40_000);
    for (const stream of [process_.stdout, process_.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
    }
    process_.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

describe('who holds the key of the retention archive', () => {
  const ARCHIVE = {
    ARCHIVE_S3_BUCKET: 'consultorio-archive',
    ARCHIVE_S3_ENDPOINT: 'https://127.0.0.1:1',
    ARCHIVE_S3_ACCESS_KEY_ID: 'archive-writer',
    ARCHIVE_S3_SECRET_ACCESS_KEY: 'placeholder-writer',
    ARCHIVE_RELEASER_KEK: Buffer.alloc(32, 7).toString('base64'),
  };

  it.each(['api', 'worker'])(
    'refuses to start the %s role when the private key of the releaser is in its environment',
    async (role) => {
      const { code, output } = await runUntilExit(role, ARCHIVE);

      expect(code).not.toBe(0);
      expect(output).toContain('ARCHIVE_RELEASER_KEK');
      expect(output).toContain('only the releaser process may hold it');
    },
    60_000,
  );

  it('refuses to start the releaser role without its key', async () => {
    const { code, output } = await runUntilExit('releaser', {});

    expect(code).not.toBe(0);
    expect(output).toContain('ARCHIVE_RELEASER_KEK');
  }, 60_000);

  it('refuses to start the releaser role on the login of the API: it has a database login of its own', async () => {
    const { code, output } = await runUntilExit('releaser', ARCHIVE);

    expect(code).not.toBe(0);
    expect(output).toContain('RELEASER_DATABASE_URL');
    expect(output).toContain('is required for the releaser');
  }, 60_000);

  it.each(['api', 'worker'])(
    'refuses to start the %s role when the login of the releaser is in its environment',
    async (role) => {
      const { code, output } = await runUntilExit(role, {
        RELEASER_DATABASE_URL: 'postgres://app_releaser:placeholder@127.0.0.1:1/app',
      });

      expect(code).not.toBe(0);
      expect(output).toContain('RELEASER_DATABASE_URL');
      expect(output).toContain('only the releaser process may hold it');
    },
    60_000,
  );

  it('refuses to start the api in production with the identity that writes the archive', async () => {
    const { ARCHIVE_RELEASER_KEK, ...writer } = ARCHIVE;
    const { code, output } = await runUntilExit('api', {
      ...writer,
      ARCHIVE_RELEASER_PUBLIC_KEY: releaserPublicKeyOf(ARCHIVE_RELEASER_KEK),
    });

    expect(code).not.toBe(0);
    expect(output).toContain('ARCHIVE_S3_ACCESS_KEY_ID');
    expect(output).toContain('the API does not write the archive');
  }, 60_000);
});
