import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RotatingLog {
  write(text: string): void;
}

export interface RotatingLogOptions {
  /** A file that reaches this size is moved aside before the next write. */
  maxBytes?: number;
  /** How many old files to keep: `name.1` is the newest. */
  keep?: number;
}

/**
 * An append-only log file that rotates by size: `api.log`, `api.log.1`, `api.log.2`... The logs of
 * the processes are the only trace a clinic can send when something fails, and they must not fill
 * the disk, so the total is bounded by `maxBytes * (keep + 1)`.
 */
export function createRotatingLog(file: string, options: RotatingLogOptions = {}): RotatingLog {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const keep = options.keep ?? 3;
  mkdirSync(dirname(file), { recursive: true });
  let size = existsSync(file) ? statSync(file).size : 0;

  function rotate(): void {
    rmSync(`${file}.${String(keep)}`, { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = `${file}.${String(index)}`;
      if (existsSync(from)) renameSync(from, `${file}.${String(index + 1)}`);
    }
    renameSync(file, `${file}.1`);
    size = 0;
  }

  return {
    write(text) {
      if (text === '') return;
      try {
        if (size >= maxBytes) rotate();
        appendFileSync(file, text);
        size += Buffer.byteLength(text);
      } catch {
        // A log that cannot be written must never stop the process it describes.
      }
    },
  };
}
