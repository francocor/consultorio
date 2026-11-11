export interface Ticker {
  start(): void;
  /** Stops scheduling and waits for a run in progress to finish. */
  stop(): Promise<void>;
}

export interface TickerOptions {
  intervalMs: number;
  tick(): Promise<void>;
  onError?(error: unknown): void;
}

/**
 * Calls `tick` every `intervalMs`, never overlapping itself: if a run is still going when the next
 * interval arrives, that interval is skipped. A failing tick is reported and does not stop the loop.
 */
export function createTicker(options: TickerOptions): Ticker {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const run = () => {
    if (running) return;
    running = options
      .tick()
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .finally(() => {
        running = undefined;
      });
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(run, options.intervalMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds from `now` until the next `hourUtc`:00 UTC (a full day if it is exactly now). */
export function msUntilNextDailyRun(now: Date, hourUtc: number): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc);
  const delta = next - now.getTime();
  return delta > 0 ? delta : delta + DAY_MS;
}

/** Runs `tick` once a day at `hourUtc`:00 UTC, with the same no-overlap and error rules. */
export function createDailyTicker(options: {
  hourUtc: number;
  tick(): Promise<void>;
  onError?(error: unknown): void;
  now?: () => Date;
}): Ticker {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  const now = options.now ?? (() => new Date());

  const schedule = () => {
    timer = setTimeout(
      () => {
        running = options
          .tick()
          .catch((error: unknown) => {
            options.onError?.(error);
          })
          .finally(() => {
            running = undefined;
          });
        if (!stopped) schedule();
      },
      msUntilNextDailyRun(now(), options.hourUtc),
    );
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}
