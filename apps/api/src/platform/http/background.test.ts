import { describe, expect, it } from 'vitest';

import { createBackgroundTasks } from './background.js';

describe('background tasks', () => {
  it('runs work after the caller moves on, and idle() waits for it', async () => {
    const tasks = createBackgroundTasks({ onError: () => undefined });
    const done: string[] = [];

    tasks.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      done.push('slow');
    });
    done.push('caller continues');

    expect(done).toEqual(['caller continues']);
    await tasks.idle();
    expect(done).toEqual(['caller continues', 'slow']);
  });

  it('reports a failure to the error handler and never rejects to the caller', async () => {
    const errors: unknown[] = [];
    const tasks = createBackgroundTasks({ onError: (error) => errors.push(error) });

    tasks.run(() => Promise.reject(new Error('mail server down')));
    await tasks.idle();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('mail server down');
  });

  it('survives an error handler that throws', async () => {
    const tasks = createBackgroundTasks({
      onError: () => {
        throw new Error('logger broke');
      },
    });

    tasks.run(() => Promise.reject(new Error('boom')));

    await expect(tasks.idle()).resolves.toBeUndefined();
  });

  it('waits for tasks that start other tasks', async () => {
    const tasks = createBackgroundTasks({ onError: () => undefined });
    const done: string[] = [];

    tasks.run(async () => {
      await Promise.resolve();
      tasks.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        done.push('inner');
      });
    });
    await tasks.idle();

    expect(done).toEqual(['inner']);
  });

  it('is idle immediately when nothing is running', async () => {
    const tasks = createBackgroundTasks({ onError: () => undefined });

    await expect(tasks.idle()).resolves.toBeUndefined();
    expect(tasks.pending()).toBe(0);
  });
});
