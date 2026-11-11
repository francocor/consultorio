/**
 * Keeps one long-running child of the install (the API, the worker) alive: starts it, waits until it says
 * it is ready, restarts it with a growing delay when it dies, gives up and says so after three failures in
 * a row, and stops it the way the bundle asks for (see "IPC and shutdown" in docs/desktop/design.md).
 */

/** The part of `ChildProcess` the supervisor uses, so a test can run it with a fake. */
export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  send(message: unknown): boolean;
  /** On Windows this is a hard kill: it is the last resort, used on this child only. */
  kill(): boolean;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export type ProcessState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';

export type Readiness =
  | { kind: 'line'; pattern: RegExp; timeoutMs: number }
  | { kind: 'poll'; probe: () => Promise<boolean>; intervalMs: number; timeoutMs: number };

export interface SupervisorOptions {
  name: string;
  /**
   * Runs before every launch, the first and each restart (to pick a free port, say). Without it the child is
   * spawned at once, in the same turn as `start()`.
   */
  prepare?: () => Promise<void>;
  spawn: () => ChildLike;
  readiness: Readiness;
  /** Every line the child writes, with the stream it came from. */
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void;
  onState?: (state: ProcessState, detail?: string) => void;
  /** Delays before each restart; the number of entries is also how many restarts are tried. */
  backoffMs?: number[];
  /** A child that stays ready this long is healthy again: its failures are forgotten. */
  stableAfterMs?: number;
  /** How long to wait for the child to exit after the shutdown message, before the hard kill. */
  shutdownTimeoutMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_BACKOFF = [1_000, 2_000];
const RECENT_ERROR_LINES = 12;

export class Supervisor {
  private child: ChildLike | null = null;
  private state: ProcessState = 'stopped';
  private failures = 0;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private stableTimer: NodeJS.Timeout | undefined;
  private readonly recentErrors: string[] = [];
  private firstReady: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private exited: Promise<void> = Promise.resolve();

  constructor(private readonly options: SupervisorOptions) {}

  get currentState(): ProcessState {
    return this.state;
  }

  /** The last lines the child wrote to its standard error, for the message of a failure. */
  get lastErrors(): string {
    return this.recentErrors.join('\n');
  }

  private setState(state: ProcessState, detail?: string): void {
    this.state = state;
    this.options.onState?.(state, detail);
  }

  private log(message: string): void {
    this.options.log?.(`[${this.options.name}] ${message}`);
  }

  /**
   * Starts the child. Resolves when it is ready for the first time, and rejects when it fails for good
   * (the third failure in a row) before that.
   */
  start(): Promise<void> {
    if (this.state !== 'stopped' && this.state !== 'failed') {
      return Promise.reject(new Error(`${this.options.name} is already running`));
    }
    this.stopping = false;
    this.failures = 0;
    const ready = new Promise<void>((resolve, reject) => {
      this.firstReady = { resolve, reject };
    });
    this.launch();
    return ready;
  }

  private launch(): void {
    this.setState(this.failures === 0 ? 'starting' : 'restarting');
    const prepare = this.options.prepare;
    if (prepare === undefined) {
      this.spawnChild();
      return;
    }
    prepare().then(
      () => {
        // Stopped while it was preparing: there is nothing to launch.
        if (!this.stopping) this.spawnChild();
      },
      (error: unknown) => {
        if (this.stopping) return;
        this.recentErrors.push(error instanceof Error ? error.message : String(error));
        this.onExit(null, null);
      },
    );
  }

  private spawnChild(): void {
    let child: ChildLike;
    try {
      child = this.options.spawn();
    } catch (error) {
      this.recentErrors.push(error instanceof Error ? error.message : String(error));
      this.onExit(null, null);
      return;
    }
    this.child = child;
    this.log(`started (pid ${String(child.pid)})`);
    let exitedResolve: () => void = () => undefined;
    this.exited = new Promise<void>((resolve) => {
      exitedResolve = resolve;
    });

    let ready = false;
    const markReady = () => {
      if (ready || this.child !== child) return;
      ready = true;
      this.setState('running');
      this.log('ready');
      this.stableTimer = setTimeout(() => {
        this.failures = 0;
      }, this.options.stableAfterMs ?? 60_000);
      this.firstReady?.resolve();
      this.firstReady = null;
    };

    const listen = (stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr') => {
      if (!stream) return;
      let pending = '';
      stream.on('data', (chunk: Buffer | string) => {
        pending += chunk.toString();
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          const line = pending.slice(0, newline).replace(/\r$/, '');
          pending = pending.slice(newline + 1);
          this.options.onOutput?.(name, line);
          if (name === 'stderr' && line.trim() !== '') {
            this.recentErrors.push(line);
            if (this.recentErrors.length > RECENT_ERROR_LINES) this.recentErrors.shift();
          }
          const readiness = this.options.readiness;
          if (readiness.kind === 'line' && readiness.pattern.test(line)) markReady();
          newline = pending.indexOf('\n');
        }
      });
    };
    listen(child.stdout, 'stdout');
    listen(child.stderr, 'stderr');

    let exitSeen = false;
    const handleExit = (code: number | null, signal: string | null) => {
      if (exitSeen) return;
      exitSeen = true;
      if (this.child === child) this.child = null;
      exitedResolve();
      this.onExit(code, signal);
    };
    child.once('exit', handleExit);
    child.once('error', (error) => {
      this.recentErrors.push(error.message);
      handleExit(null, null);
    });

    const readiness = this.options.readiness;
    if (readiness.kind === 'poll') void this.poll(child, readiness, markReady);
    else {
      const timeout = setTimeout(() => {
        if (!ready && this.child === child) {
          this.log('did not say it was ready in time');
          child.kill();
        }
      }, readiness.timeoutMs);
      void this.exited.then(() => {
        clearTimeout(timeout);
      });
    }
  }

  private async poll(
    child: ChildLike,
    readiness: Extract<Readiness, { kind: 'poll' }>,
    markReady: () => void,
  ): Promise<void> {
    const deadline = Date.now() + readiness.timeoutMs;
    while (this.child === child && Date.now() < deadline) {
      const answered = await readiness.probe().catch(() => false);
      if (answered) {
        markReady();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, readiness.intervalMs));
    }
    if (this.child === child && this.state !== 'running') {
      this.log('did not answer in time');
      child.kill();
    }
  }

  private onExit(code: number | null, signal: string | null): void {
    clearTimeout(this.stableTimer);
    if (this.stopping) {
      this.setState('stopped');
      return;
    }
    this.failures += 1;
    this.log(
      `exited (code ${String(code)}, signal ${String(signal)}); failure ${String(this.failures)}`,
    );
    const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[this.failures - 1];
    if (delay === undefined) {
      const detail = this.lastErrors;
      this.setState('failed', detail);
      this.firstReady?.reject(new Error(`${this.options.name} failed: ${detail}`));
      this.firstReady = null;
      return;
    }
    this.setState('restarting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.stopping) this.launch();
    }, delay);
  }

  /** Stops the child: the shutdown message, a wait, and only then the hard kill of this child's pid. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    clearTimeout(this.stableTimer);
    const child = this.child;
    if (!child) {
      this.setState('stopped');
      return;
    }
    this.log('asking to stop');
    try {
      child.send({ type: 'shutdown' });
    } catch {
      // The channel is gone already: the child is on its way out, or the kill below ends it.
    }
    const timeoutMs = this.options.shutdownTimeoutMs ?? 30_000;
    let killTimer: NodeJS.Timeout | undefined;
    const forced = new Promise<'forced'>((resolve) => {
      killTimer = setTimeout(() => {
        resolve('forced');
      }, timeoutMs);
    });
    const outcome = await Promise.race([this.exited.then(() => 'exited' as const), forced]);
    clearTimeout(killTimer);
    if (outcome === 'forced') {
      this.log(`did not stop in ${String(timeoutMs / 1000)} s; killing it`);
      child.kill();
      await this.exited;
    }
    this.firstReady?.reject(new Error(`${this.options.name} was stopped`));
    this.firstReady = null;
    this.setState('stopped');
  }
}
