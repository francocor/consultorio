import { parseArgs } from 'node:util';

import { startStack } from './stack/start-stack.js';

/**
 * A throwaway full stack (Postgres, Mailpit, API, worker, two demo organizations, one operator).
 *
 *   pnpm --filter @consultorio/api e2e:stack     # for the Playwright suite (port 3100)
 *   pnpm demo:stack                              # to try the app by hand (port 3000)
 *
 * Needs Docker and nothing else. Press Ctrl+C to stop it; the data goes away with it.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '3100' },
      info: { type: 'string' },
      banner: { type: 'boolean', default: false },
      'web-port': { type: 'string', default: '5173' },
    },
  });
  const port = Number(values.port);
  const stack = await startStack({
    apiPort: port,
    ...(values.info ? { infoFile: values.info } : {}),
    log: (line) => {
      process.stdout.write(`[stack] ${line}\n`);
    },
  });

  if (values.banner) {
    const web = values['web-port'];
    const { info } = stack;
    process.stdout.write(
      [
        '',
        'The stack is running. In another terminal start the web app:',
        '',
        `  API_PROXY_TARGET=http://127.0.0.1:${String(port)} pnpm --filter @consultorio/web dev`,
        '',
        `Organization "Centro Médico Aillu":  http://aillu.${info.baseDomain}:${web}`,
        `Organization "Clínica Norte":        http://norte.${info.baseDomain}:${web}   (sign in as <account>+norte@demo.invalid)`,
        `Platform console:                    http://${info.platformHost}:${web}`,
        `Mailpit (emails):                    ${info.mailpitUrl}`,
        '',
        `Password of every demo account (public, development only): ${info.demoPassword}`,
        `Accounts: propietaria@, administracion@, recepcion@, recepcion.norte@, cardiologia@, pediatria@, psicologia@ (all @demo.invalid)`,
        `Operator: ${info.operator.email} / ${info.operator.password}`,
        `Operator authenticator secret (base32): ${info.operator.totpSecret}`,
        '',
      ].join('\n'),
    );
  }

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await stack.stop();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : 'Stack failed'}\n`,
  );
  process.exit(1);
});
