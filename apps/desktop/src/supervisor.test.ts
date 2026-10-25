import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Supervisor,
  type ChildLike,
  type ProcessState,
  type SupervisorOptions,
} from './supervisor.js';

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: unknown[] = [];
  killed = false;
  constructor(readonly pid: number) {
    super();
  }
  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
  kill(): boolean {
    this.killed = true;
    this.exit(null);
    return true;
  }
  exit(code: number | null): void {
    this.emit('exit', code, null);
  }
}

let children: FakeChild[];
let states: [ProcessState, string | undefined][];
let healthy: boolean;

function supervisor(overrides: Partial<SupervisorOptions> = {}): Supervisor {
  return new Supervisor({
    name: 'api',
    spawn: () => {
      const child = new FakeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    readiness: {
      kind: 'poll',
      probe: () => Promise.resolve(healthy),
      intervalMs: 100,
      timeoutMs: 5_000,
    },
    onState: (state, detail) => states.push([state, detail]),
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  states = [];
  healthy = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('starting a process', () => {
  it('is ready when the probe says so', async () => {
    const api = supervisor();

    const ready = api.start();
    await vi.advanceTimersByTimeAsync(0);
    await ready;

    expect(api.currentState).toBe('running');
    expect(states.map(([state]) => state)).toEqual(['starting', 'running']);
  });

  it('keeps polling until the process answers', async () => {
    healthy = false;
    const api = supervisor();

    const ready = api.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(api.currentState).toBe('starting');
    healthy = true;
    await vi.advanceTimersByTimeAsync(200);
    await ready;

    expect(api.currentState).toBe('running');
  });

  it('is ready when the worker prints its line, whatever it printed before', async () => {
    const worker = supervisor({
      name: 'worker',
      readiness: { kind: 'line', pattern: /worker started/, timeoutMs: 5_000 },
    });

    const ready = worker.start();
    children[0]?.stdout.write('{"msg":"connecting"}\n{"msg":"worker started"}\n');
    await vi.advanceTimersByTimeAsync(0);
    await ready;

    expect(worker.currentState).toBe('running');
  });

  it('reads a line that arrives in pieces', async () => {
    const lines: string[] = [];
    const worker = supervisor({
      readiness: { kind: 'line', pattern: /worker started/, timeoutMs: 5_000 },
      onOutput: (_stream, line) => lines.push(line),
    });

    const ready = worker.start();
    children[0]?.stdout.write('{"msg":"worker ');
    children[0]?.stdout.write('started"}\r\n');
    await vi.advanceTimersByTimeAsync(0);
    await ready;

    expect(lines).toEqual(['{"msg":"worker started"}']);
  });

  it('does not start twice', async () => {
    const api = supervisor();
    void api.start();

    await expect(api.start()).rejects.toThrow(/already running/);
  });
});

describe('a process that dies', () => {
  it('is restarted after a delay that grows, and gives up at the third failure', async () => {
    const api = supervisor({ backoffMs: [1_000, 2_000] });
    healthy = false;
    const ready = api.start();
    ready.catch(() => undefined);

    children[0]?.stderr.write('boom 1\n');
    children[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);

    children[1]?.stderr.write('boom 2\n');
    children[1]?.exit(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(3);

    children[2]?.stderr.write('boom 3\n');
    children[2]?.exit(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(children).toHaveLength(3);
    expect(api.currentState).toBe('failed');
    await expect(ready).rejects.toThrow(/boom 3/);
    expect(states.at(-1)).toEqual(['failed', expect.stringContaining('boom 3') as string]);
  });

  it('prepares before every launch, so a restart can choose what the failed start could not', async () => {
    const prepared: number[] = [];
    const api = supervisor({
      backoffMs: [1_000],
      prepare: () => {
        prepared.push(children.length);
        return Promise.resolve();
      },
    });
    healthy = false;
    const ready = api.start();
    ready.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepared).toEqual([0]);
    expect(children).toHaveLength(1);

    children[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(prepared).toEqual([0, 1]);
    expect(children).toHaveLength(2);
  });

  it('counts a failed preparation as a failure of the start, and launches nothing', async () => {
    const api = supervisor({
      backoffMs: [],
      prepare: () => Promise.reject(new Error('no free port')),
    });
    const ready = api.start();
    ready.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(0);

    expect(children).toHaveLength(0);
    await expect(ready).rejects.toThrow(/no free port/);
  });

  it('forgets its failures once it has been healthy for a while', async () => {
    const api = supervisor({ backoffMs: [1_000, 2_000], stableAfterMs: 60_000 });
    const ready = api.start();
    await vi.advanceTimersByTimeAsync(0);
    await ready;

    children[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(61_000);
    children[1]?.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(61_000);
    children[2]?.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(children.length).toBeGreaterThanOrEqual(4);
    expect(api.currentState).not.toBe('failed');
  });

  it('is killed when it never says it is ready, and counts as a failure', async () => {
    healthy = false;
    const api = supervisor({
      backoffMs: [],
      readiness: {
        kind: 'poll',
        probe: () => Promise.resolve(false),
        intervalMs: 100,
        timeoutMs: 1_000,
      },
    });
    const ready = api.start();
    ready.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(1_500);

    expect(children[0]?.killed).toBe(true);
    await expect(ready).rejects.toThrow(/failed/);
  });

  it('counts a program that cannot even be spawned', async () => {
    const api = new Supervisor({
      name: 'api',
      spawn: () => {
        throw new Error('spawn ENOENT');
      },
      readiness: {
        kind: 'poll',
        probe: () => Promise.resolve(true),
        intervalMs: 100,
        timeoutMs: 1_000,
      },
      backoffMs: [],
    });

    const ready = api.start();
    ready.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    await expect(ready).rejects.toThrow(/spawn ENOENT/);
    expect(api.currentState).toBe('failed');
  });
});

describe('stopping a process', () => {
  it('sends the shutdown message and waits for the process to exit by itself', async () => {
    const api = supervisor();
    const ready = api.start();
    await vi.advanceTimersByTimeAsync(0);
    await ready;

    const stopped = api.stop();
    expect(children[0]?.sent).toEqual([{ type: 'shutdown' }]);
    await vi.advanceTimersByTimeAsync(5_000);
    children[0]?.exit(0);
    await stopped;

    expect(children[0]?.killed).toBe(false);
    expect(api.currentState).toBe('stopped');
  });

  it('kills that process, and only after the timeout, when it does not exit', async () => {
    const api = supervisor({ shutdownTimeoutMs: 30_000 });
    const ready = api.start();
    await vi.advanceTimersByTimeAsync(0);
    await ready;

    const stopped = api.stop();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(children[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;

    expect(children[0]?.killed).toBe(true);
    expect(api.currentState).toBe('stopped');
  });

  it('does not restart what it stopped', async () => {
    const api = supervisor();
    const ready = api.start();
    await vi.advanceTimersByTimeAsync(0);
    await ready;

    const stopped = api.stop();
    children[0]?.exit(0);
    await stopped;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(children).toHaveLength(1);
  });

  it('cancels a restart that was waiting', async () => {
    const api = supervisor({ backoffMs: [1_000, 2_000] });
    healthy = false;
    const ready = api.start();
    ready.catch(() => undefined);
    children[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(10);

    await api.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(children).toHaveLength(1);
    expect(api.currentState).toBe('stopped');
  });

  it('is fine to stop a process that never started', async () => {
    await expect(supervisor().stop()).resolves.toBeUndefined();
  });
});
