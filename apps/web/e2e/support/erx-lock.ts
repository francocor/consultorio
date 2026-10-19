import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The e-prescription provider of the demonstration organizations is one in-memory fake for the whole
 * stack, and the provider console puts it in a mode (an outage) for everybody. Two journeys that use
 * an outage would break each other if they ran at the same time on two workers, so each takes this
 * lock for the whole journey. The lock is a directory (creating it is atomic) named after the API
 * port, so two stacks on one machine do not wait for each other. A lock older than twenty minutes
 * belongs to a run that died and is taken over.
 *
 * It also guards the matricula of the pediatrician: the e-prescription journey needs that professional
 * UNverified (it is refused), and the journey of the operator's queue verifies and withdraws that very
 * registration. They hold this lock too, so the pediatrician is never verified while the other looks.
 */
const LOCK = join(tmpdir(), `consultorio-erx-mode-${process.env['E2E_API_PORT'] ?? '3100'}.lock`);
const STALE_MS = 20 * 60_000;
const POLL_MS = 2_000;

export async function acquireErxLock(timeoutMs = 15 * 60_000): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(LOCK);
      return () => {
        rmSync(LOCK, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) {
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
    } catch {
      // The holder released it between the two calls: try again at once.
      continue;
    }
    if (Date.now() > deadline) throw new Error('The e-Rx mode lock was never released.');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
