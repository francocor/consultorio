import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

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
