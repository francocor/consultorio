import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface RotatingLog {
  write(text: string): void;
}

export interface RotatingLogOptions {
  /** A file that reaches this size is moved aside before the next write. */
  maxBytes?: number;
  /** How many old files to keep: `name.1` is the newest. */
  keep?: number;
  /** Applied to every text before it is written (to take out what must not be kept). */
  transform?: (text: string) => string;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;

/**
 * Moves `file` to `file.1` (and `file.1` to `file.2`, up to `keep`). A file another program holds open, or
 * a name that is taken, must never stop the log: when it cannot be moved it is emptied, and when that fails
 * too it is deleted. The old copies are best effort, the bound on the disk is not.
 */
function shiftAndMove(file: string, keep: number): void {
  try {
    rmSync(`${file}.${String(keep)}`, { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = `${file}.${String(index)}`;
      if (existsSync(from)) renameSync(from, `${file}.${String(index + 1)}`);
    }
  } catch {
    // The older copies are not worth losing the newest write over.
  }
  try {
    renameSync(file, `${file}.1`);
    return;
  } catch {
    // Antivirus or indexer holding it, or `file.1` is in the way: empty it where it stands.
  }
  try {
    writeFileSync(file, '');
  } catch {
    rmSync(file, { force: true });
  }
}

/**
 * Moves `file` aside when it has reached `maxBytes`. For a log another program appends to (PostgreSQL's), done
 * before that program starts. Returns whether it moved the file.
 */
export function rotateBySize(file: string, options: RotatingLogOptions = {}): boolean {
  try {
    if (!existsSync(file) || statSync(file).size < (options.maxBytes ?? DEFAULT_MAX_BYTES)) {
      return false;
    }
    shiftAndMove(file, options.keep ?? DEFAULT_KEEP);
    return true;
  } catch {
    return false;
  }
}

/**
 * An append-only log file that rotates by size: `api.log`, `api.log.1`, `api.log.2`... The logs of
 * the processes are the only trace a clinic can send when something fails, and they must not fill
 * the disk, so the total is bounded by `maxBytes * (keep + 1)`.
 */
export function createRotatingLog(file: string, options: RotatingLogOptions = {}): RotatingLog {
  const transform = options.transform ?? ((text: string) => text);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = options.keep ?? DEFAULT_KEEP;
  mkdirSync(dirname(file), { recursive: true });
  let size = existsSync(file) ? statSync(file).size : 0;

  function rotate(): void {
    shiftAndMove(file, keep);
    size = 0;
  }

  return {
    write(raw) {
      if (raw === '') return;
      try {
        const text = transform(raw);
        if (size >= maxBytes) rotate();
        appendFileSync(file, text);
        size += Buffer.byteLength(text);
      } catch {
        // A log that cannot be written must never stop the process it describes.
      }
    },
  };
}
