import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The outbox holds the mail the product wanted to send (`.eml` and the `.json` beside it) and, in it, live
 * links to reset a password or accept an invitation. A week is longer than any of those links lasts, so
 * what is older than that is only a risk. Returns how many files it deleted.
 */
export async function pruneOutbox(
  directory: string,
  now: () => number = Date.now,
  maxAgeMs = OUTBOX_MAX_AGE_MS,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    if (!name.endsWith('.eml') && !name.endsWith('.json')) continue;
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (info.isFile() && now() - info.mtimeMs > maxAgeMs) {
        await rm(path, { force: true });
        deleted += 1;
      }
    } catch {
      // The file went away between the listing and the check; nothing to do.
    }
  }
  return deleted;
}
