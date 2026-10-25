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

/** The stored port while it is free, else the preferred one on the first run, else any free one. */
export async function chooseServerPort(
  stored: number | null,
  isFree: (port: number) => Promise<boolean> = isPortFree,
  freePort: () => Promise<number> = findFreePort,
): Promise<number> {
  if (stored !== null && (await isFree(stored))) return stored;
  if (stored === null && (await isFree(PREFERRED_PORT))) return PREFERRED_PORT;
  return freePort();
}
