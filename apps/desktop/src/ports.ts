import { createServer } from 'node:net';

/** True when nothing listens on `host:port`. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

/** A port the system picks, free at this moment. */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ port: 0, host, exclusive: true }, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('no free port'));
      });
    });
  });
}

/** The port the local server keeps for the life of the install: `PUBLIC_URL` must not change. */
export const PREFERRED_PORT = 47800;

export interface PortRetry {
  /** How many times the stored port is looked at before the server moves. */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The stored port while it is free, else the preferred one on the first run, else any free one. A stored
 * port that is busy is looked at again a few times first: a program that closed a moment ago, or the
 * previous run of this one still shutting down, frees it, and every address in an email already sent
 * names it.
 */
export async function chooseServerPort(
  stored: number | null,
  isFree: (port: number) => Promise<boolean> = isPortFree,
  freePort: () => Promise<number> = findFreePort,
  retry: PortRetry = {},
): Promise<number> {
  if (stored !== null) {
    const attempts = retry.attempts ?? 4;
    const sleep =
      retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (await isFree(stored)) return stored;
      if (attempt < attempts) await sleep(retry.delayMs ?? 500);
    }
  } else if (await isFree(PREFERRED_PORT)) {
    return PREFERRED_PORT;
  }
  return freePort();
}
