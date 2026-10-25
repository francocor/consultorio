import type { EventEmitter } from 'node:events';
import { fstatSync } from 'node:fs';

/** The parts of `process` that decide when to stop, so a test can stand in for them. */
export interface ShutdownProcess extends EventEmitter {
  /** Present only when the process was started with an IPC channel to its parent. */
  send?: ((message: never) => boolean) | undefined;
  stdin?: EventEmitter | undefined;
}

export interface ShutdownOptions {
  process?: ShutdownProcess;
  /** Whether the standard input is a pipe or a socket, which a parent holds open on purpose. */
  stdinIsPipe?: () => boolean;
}

/** The file type bits of a mode, and the two types a parent holds open: a pipe and a socket. */
const FILE_TYPE_MASK = 0o170000;
const FILE_TYPE_PIPE = 0o010000;
const FILE_TYPE_SOCKET = 0o140000;

/**
 * Whether file descriptor 0 is a pipe or a socket. A terminal, the null device of an ignored input
 * and a file are not: they are at end-of-file, or silent, whatever the parent does. The mode is read
 * by hand because `Stats.isFIFO()` is always false on Windows, where a pipe is exactly what the
 * desktop shell hands to its child.
 */
function standardInputIsPipe(): boolean {
  try {
    const type = fstatSync(0).mode & FILE_TYPE_MASK;
    return type === FILE_TYPE_PIPE || type === FILE_TYPE_SOCKET;
  } catch {
    return false;
  }
}

/** The shutdown message of the parent: `{ "type": "shutdown" }`. Anything else is not for us. */
function isShutdownMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'shutdown'
  );
}

/**
 * Resolves when the process is asked to stop, so `main` can close what it holds and let the process
 * end by itself (exit code 0). Asked means:
 *
 * - `SIGINT` or `SIGTERM`, as before: a terminal, a container, a service manager.
 * - A message `{ "type": "shutdown" }` over the IPC channel. On Windows `child.kill()` is
 *   `TerminateProcess`: a hard kill that runs nothing, and there are no signals to send instead. The
 *   desktop shell asks over the channel and waits for the exit.
 * - The channel closing (`disconnect`): the parent is gone, and an API with no shell to serve
 *   would be an orphan.
 * - The standard input closing, but only for a process that has a channel to its parent and whose
 *   input is a pipe. Both together mean "a parent started me and holds my input"; without either, an
 *   empty input (a container, an ignored one) would stop a process that was never meant to follow it.
 */
export function waitForShutdown(options: ShutdownOptions = {}): Promise<void> {
  const proc = options.process ?? process;
  const stdinIsPipe = options.stdinIsPipe ?? standardInputIsPipe;
  const hasChannel = typeof proc.send === 'function';

  return new Promise((resolve) => {
    const stdin = hasChannel && stdinIsPipe() ? proc.stdin : undefined;

    function done(): void {
      for (const signal of ['SIGINT', 'SIGTERM']) proc.off(signal, done);
      proc.off('message', onMessage);
      proc.off('disconnect', done);
      stdin?.off('end', done);
      stdin?.off('close', done);
      // A stream that is being read keeps the process alive: stop reading, so the process can end.
      (stdin as { pause?: () => void } | undefined)?.pause?.();
      resolve();
    }
    function onMessage(message: unknown): void {
      if (isShutdownMessage(message)) done();
    }

    proc.on('SIGINT', done);
    proc.on('SIGTERM', done);
    if (hasChannel) {
      proc.on('message', onMessage);
      proc.on('disconnect', done);
    }
    if (stdin) {
      stdin.on('end', done);
      stdin.on('close', done);
      // A stream only ends if somebody reads it; discard what arrives (a parent has nothing to say here).
      (stdin as { resume?: () => void }).resume?.();
    }
  });
}
