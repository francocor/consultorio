import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

import { listFiles, sizeOf } from './files.js';

/** There is not room on the disk for what is about to be written. The numbers are for the message. */
export class DiskFullError extends Error {
  constructor(
    /** Bytes the operation needs, or 0 when the disk answered "full" and nobody counted. */
    readonly needed: number,
    /** Bytes free where it was going to write. */
    readonly free: number,
  ) {
    super('disk_full');
    this.name = 'DiskFullError';
  }
}

/** Free bytes on the volume that holds `folder` (or the nearest parent that exists). */
export async function freeBytes(folder: string): Promise<number> {
  let current = folder;
  for (;;) {
    try {
      const info = await statfs(current);
      return info.bavail * info.bsize;
    } catch (error) {
      const parent = dirname(current);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw error;
      current = parent;
    }
  }
}

/** The size of everything under `folder`, in bytes (0 when it is not there). */
export async function directoryBytes(folder: string): Promise<number> {
  let total = 0;
  for (const file of await listFiles(folder)) total += await sizeOf(file.file);
  return total;
}

/** Margin for the file system and the work files, on top of what is counted. */
const MARGIN_BYTES = 64 * 1024 * 1024;

/**
 * Refuses, before anything is written, an operation that needs `needed` bytes where `folder` has less. A
 * disk that fills in the middle of a backup or a restore leaves the most work half done, so it is checked first.
 */
export async function ensureRoom(options: {
  folder: string;
  needed: number;
  freeBytes?: (folder: string) => Promise<number>;
}): Promise<void> {
  const free = await (options.freeBytes ?? freeBytes)(options.folder);
  const needed = options.needed + MARGIN_BYTES;
  if (free < needed) throw new DiskFullError(needed, free);
}

/** True for the error a full disk raises while writing. */
export function isDiskFull(error: unknown): boolean {
  return (
    error instanceof DiskFullError || (error as NodeJS.ErrnoException | null)?.code === 'ENOSPC'
  );
}
