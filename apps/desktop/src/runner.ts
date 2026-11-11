import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  /** The whole environment of the child. It is NOT merged with ours. */
  env?: NodeJS.ProcessEnv;
  /** Written to the standard input, then the input is closed. */
  input?: string;
  /** The child is killed (that process only) when it runs longer. */
  timeoutMs?: number;
  /**
   * The program leaves a process behind that keeps its pipes open (`pg_ctl start` leaves the server).
   * The result is then given when the program itself exits, not when the pipes close.
   */
  leavesChildren?: boolean;
}

export interface RunResult {
  /** `null` when the child was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a program to its end. The seam that lets every module be tested without starting anything. */
export type Runner = (file: string, args: string[], options?: RunOptions) => Promise<RunResult>;

/** The largest output kept per stream: a runaway child must not fill the memory of the shell. */
const MAX_CAPTURE = 1024 * 1024;

export const spawnRunner: Runner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const append = (current: string, chunk: Buffer) =>
      current.length >= MAX_CAPTURE ? current : current + chunk.toString('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs);
    }
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    const done = (code: number | null) => {
      if (timer) clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, stdout, stderr, timedOut });
    };
    // `close` comes after the last byte of both pipes. A program that leaves a server behind keeps them
    // open for as long as the server lives, so it is waited for with `exit` instead.
    if (options.leavesChildren === true) child.once('exit', done);
    else child.once('close', done);
    child.stdin.on('error', () => {
      // The child may exit before reading its input; its exit code says what happened.
    });
    child.stdin.end(options.input ?? '');
  });
