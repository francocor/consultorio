import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { DumpProcess } from './backup.js';

/** The two ways the PostgreSQL client tools are used with a stream: `pg_dump` out, `pg_restore` in. */
export interface PgTools {
  /** Starts a program whose standard output is a stream (`pg_dump` without `--file`). */
  dump(file: string, args: string[], env: NodeJS.ProcessEnv): DumpProcess;
  /** Runs a program fed from a stream (`pg_restore` without a file name). */
  restore(
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    source: Readable,
  ): Promise<{ code: number | null; stderr: string }>;
}

const MAX_STDERR = 64 * 1024;

function collectStderr(child: ReturnType<typeof spawn>): () => string {
  let text = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (text.length < MAX_STDERR) text += chunk.toString('utf8');
  });
  return () => text;
}

export const spawnPgTools: PgTools = {
  dump(file, args, env) {
    const child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = collectStderr(child);
    const finished = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        resolve({ code, stderr: stderr() });
      });
    });
    // A tool that cannot even start has no output to read: end the stream so the reader does not wait.
    child.once('error', () => child.stdout.destroy());
    return { stdout: child.stdout, finished };
  },

  restore(file, args, env, source) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const stderr = collectStderr(child);
      child.stdout.resume();
      child.once('error', reject);
      child.once('close', (code) => {
        source.destroy();
        resolve({ code, stderr: stderr() });
      });
      // pg_restore may stop reading (an error in the dump): the failure is its exit code, not a broken pipe.
      child.stdin.on('error', () => undefined);
      source.on('error', () => {
        child.stdin.destroy();
      });
      source.pipe(child.stdin);
    });
  },
};
