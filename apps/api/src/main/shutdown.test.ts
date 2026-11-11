import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitForShutdown } from './shutdown.js';

/** A process with the parts `waitForShutdown` looks at, and nothing else. */
function fakeProcess(options: { ipc?: boolean } = {}) {
  const proc = Object.assign(new EventEmitter(), {
    send: options.ipc ? () => true : undefined,
    stdin: new EventEmitter(),
  });
  return proc;
}

const settled = async (promise: Promise<void>) => {
  const outcome = await Promise.race([
    promise.then(() => 'resolved'),
    new Promise<string>((resolve) =>
      setTimeout(() => {
        resolve('waiting');
      }, 20),
    ),
  ]);
  return outcome;
};

describe('waiting for the signal to stop', () => {
  it.each(['SIGINT', 'SIGTERM'])('ends on %s, as it always did', async (signal) => {
    const proc = fakeProcess();
    const waiting = waitForShutdown({ process: proc, stdinIsPipe: () => false });

    expect(await settled(waiting)).toBe('waiting');
    proc.emit(signal);

    expect(await settled(waiting)).toBe('resolved');
  });

  it('ends on the shutdown message of the parent', async () => {
    const proc = fakeProcess({ ipc: true });
    const waiting = waitForShutdown({ process: proc, stdinIsPipe: () => false });

    proc.emit('message', { type: 'shutdown' });

    expect(await settled(waiting)).toBe('resolved');
  });

  it.each([
    ['another message', { type: 'ping' }],
    ['a message of the wrong shape', 'shutdown'],
    ['a null message', null],
    ['a message with a type that is not a string', { type: 1 }],
    ['an empty object', {}],
  ])('does not end on %s', async (_name, message) => {
    const proc = fakeProcess({ ipc: true });
    const waiting = waitForShutdown({ process: proc, stdinIsPipe: () => false });

    proc.emit('message', message);

    expect(await settled(waiting)).toBe('waiting');
    proc.emit('SIGTERM');
  });

  it('ends when the parent goes away and the channel is closed', async () => {
    const proc = fakeProcess({ ipc: true });
    const waiting = waitForShutdown({ process: proc, stdinIsPipe: () => false });

    proc.emit('disconnect');

    expect(await settled(waiting)).toBe('resolved');
  });

  it('ends when the standard input closes, if there is a channel to the parent and the input is a pipe', async () => {
    const proc = fakeProcess({ ipc: true });
    const waiting = waitForShutdown({ process: proc, stdinIsPipe: () => true });

    proc.stdin.emit('end');

    expect(await settled(waiting)).toBe('resolved');
  });

  it('ignores the standard input without a channel to the parent: a container reads an empty one', async () => {
    const proc = fakeProcess();
    const waiting = waitForShutdown({ process: proc, stdinIsPipe: () => true });

    proc.stdin.emit('end');
    proc.stdin.emit('close');

    expect(await settled(waiting)).toBe('waiting');
    proc.emit('SIGTERM');
  });

  it('ignores a standard input that is not a pipe: an ignored one reads end-of-file at once', async () => {
    const proc = fakeProcess({ ipc: true });
    const waiting = waitForShutdown({ process: proc, stdinIsPipe: () => false });

    proc.stdin.emit('end');

    expect(await settled(waiting)).toBe('waiting');
    proc.emit('SIGTERM');
  });

  it('lets go of every listener once it ends, so a later signal is not swallowed', async () => {
    const proc = fakeProcess({ ipc: true });
    const waiting = waitForShutdown({ process: proc, stdinIsPipe: () => true });

    proc.emit('message', { type: 'shutdown' });
    await waiting;

    for (const event of ['SIGINT', 'SIGTERM', 'message', 'disconnect']) {
      expect(proc.listenerCount(event), event).toBe(0);
    }
    expect(proc.stdin.listenerCount('end')).toBe(0);
    expect(proc.stdin.listenerCount('close')).toBe(0);
  });
});

describe('in a real child process', () => {
  const source = fileURLToPath(new URL('../../test/support/shutdown-child.ts', import.meta.url));
  let folder = '';
  /**
   * The fixture, compiled once to a plain file. Started through the `tsx` loader, the child spent more than a
   * minute getting up when the whole monorepo was being tested at once (it transpiles on every start, on a
   * PC with every core busy); a compiled file starts as fast as Node does, whatever else is running.
   */
  let fixture = '';

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'consulvia-shutdown-child-'));
    fixture = join(folder, 'shutdown-child.mjs');
    await build({
      entryPoints: [source],
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
  }, 120_000);

  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  /** The child announces `up` over the channel, waits to be told to stop, and prints `stopped`. */
  function start(stdio: ('pipe' | 'ignore' | 'ipc')[]) {
    const child = fork(fixture, [], { stdio: stdio as never });
    const output: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    const up = new Promise<void>((resolve, reject) => {
      child.on('message', (message: { type?: string }) => {
        if (message.type === 'up') resolve();
      });
      child.on('error', reject);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => {
        resolve(code);
      });
    });
    return { child, up, exited, output };
  }

  const within = async <T>(promise: Promise<T>, ms = 60_000) =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error('timed out'));
        }, ms),
      ),
    ]);

  const stopAnyway = (child: ChildProcess) => {
    if (child.exitCode === null) child.kill();
  };

  it('stops with exit code 0 when the parent sends the shutdown message', async () => {
    const { child, up, exited, output } = start(['pipe', 'pipe', 'pipe', 'ipc']);
    try {
      await within(up);

      child.send({ type: 'shutdown' });

      expect(await within(exited)).toBe(0);
      expect(output.join('')).toContain('stopped');
    } finally {
      stopAnyway(child);
    }
  }, 90_000);

  it('stops when the parent closes the channel', async () => {
    const { child, up, exited } = start(['pipe', 'pipe', 'pipe', 'ipc']);
    try {
      await within(up);

      child.disconnect();

      expect(await within(exited)).toBe(0);
    } finally {
      stopAnyway(child);
    }
  }, 90_000);

  it('stops when the parent closes the standard input of the child', async () => {
    const { child, up, exited } = start(['pipe', 'pipe', 'pipe', 'ipc']);
    try {
      await within(up);

      child.stdin?.end();

      expect(await within(exited)).toBe(0);
    } finally {
      stopAnyway(child);
    }
  }, 90_000);

  it('keeps running when the standard input was ignored, and still stops on the message', async () => {
    const { child, up, exited } = start(['ignore', 'pipe', 'pipe', 'ipc']);
    try {
      await within(up);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(child.exitCode).toBeNull();

      child.send({ type: 'shutdown' });

      expect(await within(exited)).toBe(0);
    } finally {
      stopAnyway(child);
    }
  }, 90_000);
});
