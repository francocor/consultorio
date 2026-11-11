import type { FastifyInstance } from 'fastify';

export interface BackgroundTasks {
  /**
   * Starts work that must not delay the response, such as sending an email after a password reset
   * request. Doing it after the response keeps the time of a request the same whether or not the
   * account exists. A failure goes to `onError`; it never reaches the caller.
   */
  run(work: () => Promise<void>): void;
  /** Resolves when everything started so far (and anything it started) has finished. */
  idle(): Promise<void>;
  pending(): number;
}

export function createBackgroundTasks(options: {
  onError: (error: unknown) => void;
}): BackgroundTasks {
  const running = new Set<Promise<void>>();

  return {
    run(work) {
      const task: Promise<void> = Promise.resolve()
        .then(work)
        .catch((error: unknown) => {
          try {
            options.onError(error);
          } catch {
            // A broken error channel must not become an unhandled rejection.
          }
        })
        .finally(() => {
          running.delete(task);
        });
      running.add(task);
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running]);
    },
    pending: () => running.size,
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Work started by requests that outlives the response. Closing the server waits for it. */
    background: BackgroundTasks;
  }
}

/** Gives the server a task runner and makes `app.close()` wait for unfinished work. */
export function registerBackgroundTasks(app: FastifyInstance): BackgroundTasks {
  const tasks = createBackgroundTasks({
    // Only an error code reaches the log: messages may carry addresses.
    onError: (error) => {
      const code = (error as { code?: unknown } | null)?.code;
      app.log.error(
        { code: typeof code === 'string' ? code : 'unknown' },
        'background task failed',
      );
    },
  });
  app.decorate('background', tasks);
  app.addHook('onClose', async () => {
    await tasks.idle();
  });
  return tasks;
}
