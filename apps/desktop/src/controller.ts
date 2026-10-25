import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import { ApiCommandError, EXIT, type ApiCommands } from './api-commands.js';
import {
  commandEnvironment,
  longRunningEnvironment,
  migrateEnvironment,
  osEnvironment,
  publicUrl,
  type LongRunningRole,
  type RuntimeContext,
} from './api-env.js';
import {
  BackupError,
  createBackup,
  localDay,
  pruneBackups,
  type AdoptionPayload,
} from './backup.js';
import {
  ConfigError,
  newInstallConfig,
  type ConfigStore,
  type InstallConfig,
} from './config-store.js';
import {
  createInternalPages,
  PURPOSE,
  type PageActions,
  type SetupOutcome,
} from './internal-pages.js';
import { createLocalServer, loadContentSecurityPolicy, type LocalServer } from './local-server.js';
import { pruneOutbox } from './outbox.js';
import { loadCommonPasswordsSync, messagesForIssues } from './password-check.js';
import type { DataPaths } from './paths.js';
import { chooseServerPort, findFreePort } from './ports.js';
import { DATABASE_NAME, type PostgresCluster, PostgresError, SUPERUSER } from './postgres.js';
import { migrationCountOf, missingResources, type Resources } from './resources.js';
import { readBackupInfo, restoreBackup, RestoreError, type AdoptedSecrets } from './restore.js';
import { parameterizeRolesScript } from './roles.js';
import type { RotatingLog } from './rotating-log.js';
import { generateSecrets } from './secrets.js';
import { INSTALL_SLUG, type SetupValues } from './setup-validation.js';
import type { PgTools } from './streams.js';
import { TEXT } from './strings.js';
import { Supervisor, type ChildLike, type ProcessState } from './supervisor.js';
import { TokenVault } from './tokens.js';

/** What the controller needs from the windows, dialogs and the tray. Electron implements it; tests fake it. */
export interface ShellUi {
  /** Shows a waiting page, or a message, in the main window. */
  showSplash(message: string, busy?: boolean): void;
  loadUrl(url: string): void;
  showMainWindow(): void;
  openAuxWindow(url: string, title: string): void;
  closeAuxWindow(): void;
  confirm(options: {
    title: string;
    message: string;
    detail: string;
    confirm: string;
    cancel: string;
  }): Promise<boolean>;
  message(kind: 'info' | 'error', title: string, message: string, detail?: string): Promise<void>;
  /** A dialog with buttons; resolves to the index of the one pressed. */
  choose(options: {
    kind: 'info' | 'error';
    title: string;
    message: string;
    detail?: string;
    buttons: string[];
  }): Promise<number>;
  notify(title: string, body: string): void;
  pickFile(options: {
    title: string;
    defaultPath: string;
    filterName: string;
  }): Promise<string | null>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): void;
  setAutoStart(enabled: boolean): void;
  copyToClipboard(text: string): void;
}

export type Phase = 'starting' | 'setup' | 'ready' | 'error' | 'quitting';

export interface ControllerDeps {
  paths: DataPaths;
  resources: Resources;
  store: ConfigStore;
  /** The PostgreSQL client tools, with their output and input as streams. */
  pgTools: PgTools;
  commands: ApiCommands;
  ui: ShellUi;
  version: string;
  /** Starts `api` or `worker` of the bundle as a child process with an IPC channel. */
  spawnLongRunning: (role: LongRunningRole, env: NodeJS.ProcessEnv) => ChildLike;
  /** True when `GET /health` of the API on this port answers 200. */
  probeHealth: (port: number) => Promise<boolean>;
  createCluster: (secrets: InstallConfig['secrets']) => PostgresCluster;
  logs: { shell: RotatingLog; api: RotatingLog; worker: RotatingLog };
  /** The tests of the installer drive the app from outside; some conveniences exist only then. */
  testMode: boolean;
  now: () => Date;
  /** Leaves the program (the dialogs ask for it). The caller ends with `quit()`. */
  requestQuit: () => void;
}

/** A failure whose message for the user is already known. */
export class ShellError extends Error {
  constructor(
    readonly userMessage: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'ShellError';
  }
}

const HOUR_MS = 60 * 60 * 1000;

/** Where a backup is restored before it replaces the live database. */
const SCRATCH_DATABASE = 'consultorio_restore';

function describeError(error: unknown): { message: string; detail: string } {
  if (error instanceof ShellError) return { message: error.userMessage, detail: error.message };
  if (error instanceof ConfigError) {
    const message =
      error.code === 'cannot_decrypt'
        ? TEXT.errors.cannotDecrypt
        : error.code === 'cipher_unavailable'
          ? TEXT.errors.cipherUnavailable
          : TEXT.errors.configUnreadable;
    return { message, detail: error.message };
  }
  if (error instanceof PostgresError) {
    return { message: TEXT.errors.database, detail: `${error.message}\n${error.detail}` };
  }
  if (error instanceof ApiCommandError) {
    const message = error.command === 'migrate' ? TEXT.errors.migration : TEXT.errors.generic;
    return { message, detail: `${error.message}\n${error.stderr}` };
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' || code === 'EACCES') {
      return { message: TEXT.errors.portBusy, detail: error.message };
    }
    return { message: TEXT.errors.generic, detail: error.stack ?? error.message };
  }
  return { message: TEXT.errors.generic, detail: String(error) };
}

/**
 * The life of an install: the first run, every start, the backups, the restore, the reset of the owner's
 * password and the quit. It owns the database server, the API, the worker and the local server, and it
 * talks to the user only through `ShellUi`.
 */
export class Controller {
  private loaded: InstallConfig | null = null;
  private clusterOrNull: PostgresCluster | null = null;
  private server: LocalServer | null = null;
  private apiPort: number | null = null;
  private api: Supervisor | null = null;
  private worker: Supervisor | null = null;
  private readonly vault = new TokenVault();
  private currentPhase: Phase = 'starting';
  private bootRun: Promise<void> = Promise.resolve();
  private quitPromise: Promise<void> | null = null;
  private busy = false;
  private restoring = false;
  /** The backup or restore that is running, so quitting waits for it instead of stopping the database under it. */
  private inFlight: Promise<void> = Promise.resolve();
  private setupRunning = false;
  private reportedFailure = false;
  private dailyTimer: NodeJS.Timeout | undefined;
  private lastDailyFailure: string | null = null;
  private commonPasswordSet: ReadonlySet<string> | null = null;
  private pendingRestore: { archive: string } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ControllerDeps) {}

  private get config(): InstallConfig {
    if (!this.loaded) throw new Error('The configuration is not loaded yet');
    return this.loaded;
  }

  private set config(value: InstallConfig) {
    this.loaded = value;
  }

  private get cluster(): PostgresCluster {
    if (!this.clusterOrNull) throw new Error('The database is not set up yet');
    return this.clusterOrNull;
  }

  get phase(): Phase {
    return this.currentPhase;
  }

  get autoStart(): boolean {
    return this.loaded?.settings.autoStart ?? false;
  }

  get appUrl(): string {
    return publicUrl(this.config.port);
  }

  get trayHintShown(): boolean {
    return this.loaded?.settings.trayHintShown ?? true;
  }

  /** Called when the phase or a setting changes, so the tray can redraw. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private isQuitting(): boolean {
    return this.currentPhase === 'quitting';
  }

  private setPhase(phase: Phase): void {
    this.currentPhase = phase;
    this.changed();
  }

  private log(message: string): void {
    this.deps.logs.shell.write(`${this.deps.now().toISOString()} ${message}\n`);
  }

  // ---- start ------------------------------------------------------------------------------------

  /** Starts the install. Never rejects: a failure is shown to the user and leaves the controller in `error`. */
  start(): Promise<void> {
    this.bootRun = this.boot();
    return this.bootRun.catch((error: unknown) => this.fail(error));
  }

  private async fail(error: unknown): Promise<void> {
    if (this.isQuitting()) return;
    const { message, detail } = describeError(error);
    this.log(`startup failed: ${detail}`);
    this.setPhase('error');
    this.deps.ui.showSplash(message, false);
    const choice = await this.deps.ui.choose({
      kind: 'error',
      title: TEXT.errors.title,
      message,
      buttons: [TEXT.errors.retry, TEXT.errors.logs, TEXT.errors.quit],
    });
    if (this.isQuitting()) return;
    if (choice === 1) {
      await this.deps.ui.openPath(this.deps.paths.logs);
      await this.fail(error);
    } else if (choice === 0) {
      await this.stopEverything();
      await this.start();
    } else {
      this.deps.requestQuit();
    }
  }

  private async boot(): Promise<void> {
    const { paths, resources, ui } = this.deps;
    ui.showSplash(TEXT.splash.starting);
    this.setPhase('starting');
    await mkdir(paths.root, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    this.log(`starting Consulvia ${this.deps.version}`);

    const missing = missingResources(resources);
    if (missing.length > 0) {
      throw new ShellError(TEXT.errors.missingFiles, `missing: ${missing.join(', ')}`);
    }

    await this.loadOrCreateConfig();
    await this.startLocalServer();
    this.clusterOrNull = this.deps.createCluster(this.config.secrets);

    ui.showSplash(TEXT.splash.database);
    await this.prepareDatabase();

    await this.deps.commands.migrate(
      migrateEnvironment({ config: this.config, databasePort: this.requireDatabasePort() }),
    );
    this.log('migrations applied');

    if (!this.config.provisioned) {
      this.beginSetup();
      return;
    }
    await this.startServices();
    this.finishStart();
  }

  private async loadOrCreateConfig(): Promise<void> {
    const { store } = this.deps;
    if (store.exists()) {
      try {
        this.config = store.read();
      } catch (error) {
        // The previous good copy, kept by every write, may still be readable.
        const previous = store.previous();
        if (!(error instanceof ConfigError) || error.code !== 'unreadable' || !previous.exists()) {
          throw error;
        }
        this.config = previous.read();
        store.write(this.config);
        this.log('config.json was damaged; restored from config.json.bak');
      }
    } else {
      // A data folder without its configuration cannot be opened: the keys died with the file. It is
      // set aside, never deleted, in case the configuration comes back.
      await this.setAsideOrphanedData();
      const port = await chooseServerPort(null);
      this.config = newInstallConfig(port, generateSecrets());
      this.config.slug = INSTALL_SLUG;
      store.write(this.config);
      this.log('new install configured');
    }
    this.commonPasswordSet = null;
  }

  private async setAsideOrphanedData(): Promise<void> {
    const { pgdata, files } = this.deps.paths;
    const stamp = String(this.deps.now().getTime());
    for (const folder of [pgdata, files]) {
      try {
        await rename(folder, `${folder}.orphaned-${stamp}`);
        this.log(`set aside data without a configuration: ${folder}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private async startLocalServer(): Promise<void> {
    const { resources, paths } = this.deps;
    const port = await chooseServerPort(this.config.port);
    if (port !== this.config.port) {
      this.log(
        `port ${String(this.config.port)} is in use; the local server moves to ${String(port)}`,
      );
      this.config = this.deps.store.update((config) => {
        config.port = port;
      });
    }
    const policy = loadContentSecurityPolicy(resources.webRoot);
    if (policy === null) {
      throw new ShellError(TEXT.errors.missingFiles, 'missing: content-security-policy.txt');
    }
    this.server = createLocalServer({
      port,
      webRoot: resources.webRoot,
      contentSecurityPolicy: policy,
      apiPort: () => this.apiPort,
      pages: createInternalPages(this.vault, this.pageActions()),
      log: (message) => {
        this.log(message);
      },
    });
    await this.server.listen();
    await mkdir(paths.files, { recursive: true });
    await mkdir(paths.outbox, { recursive: true });
    this.log(`local server on 127.0.0.1:${String(port)}`);
  }

  private requireDatabasePort(): number {
    const port = this.cluster.runningPort;
    if (port === null) throw new PostgresError('the database server is not running');
    return port;
  }

  private async prepareDatabase(): Promise<void> {
    const { paths, resources } = this.deps;
    if (this.config.databaseState !== 'ready') {
      // A first run that stopped half way has no user data yet: it starts over.
      await rm(paths.pgdata, { recursive: true, force: true });
      await this.cluster.initCluster();
      await this.cluster.start();
      await this.cluster.ensureDatabase();
      const script = parameterizeRolesScript(await readFile(resources.rolesSql, 'utf8'), {
        appOwner: this.config.secrets.appOwnerPassword,
        appRw: this.config.secrets.appRwPassword,
        auditSealer: this.config.secrets.auditSealerPassword,
      });
      await this.cluster.runScript(script);
      this.config = this.deps.store.update((config) => {
        config.databaseState = 'ready';
      });
      this.log('database roles created');
      return;
    }
    await this.cluster.start();
  }

  // ---- first run --------------------------------------------------------------------------------

  private beginSetup(): void {
    const token = this.vault.issue(PURPOSE.setup);
    const url = `${this.appUrl}/__setup?t=${token}`;
    this.setPhase('setup');
    this.deps.ui.loadUrl(url);
    // The address with its token is a secret of this run. It is written down only for the tests of the
    // installer, which drive the setup screen from outside.
    if (this.deps.testMode) this.log(`setup url: ${url}`);
  }

  private async runSetup(values: SetupValues): Promise<SetupOutcome> {
    if (this.setupRunning || this.config.provisioned) {
      return { ok: false, message: TEXT.setup.busy };
    }
    this.setupRunning = true;
    try {
      const context: RuntimeContext = {
        config: this.config,
        paths: this.deps.paths,
        databasePort: this.requireDatabasePort(),
        apiPort: 0,
        serverPort: this.config.port,
      };
      try {
        await this.deps.commands.provision(commandEnvironment(context), {
          organizationName: values.organizationName,
          ownerName: values.ownerName,
          ownerEmail: values.ownerEmail,
          ownerPassword: values.ownerPassword,
          timeZone: values.timeZone,
        });
      } catch (error) {
        return this.setupFailure(error);
      }
      this.config = this.deps.store.update((config) => {
        config.provisioned = true;
      });
      this.log('organization created');
      try {
        await this.startServices();
      } catch (error) {
        // The organization exists; the next start brings the services up. Let the user retry or read the logs.
        void this.fail(error);
        return { ok: false, message: TEXT.errors.service };
      }
      this.vault.revoke(PURPOSE.setup);
      this.finishStart({ keepWindow: true });
      return { ok: true, recoveryKey: this.config.secrets.recoveryKey ?? '' };
    } catch (error) {
      this.log(`setup failed: ${describeError(error).detail}`);
      return { ok: false, message: describeError(error).message };
    } finally {
      this.setupRunning = false;
    }
  }

  private setupFailure(error: unknown): SetupOutcome {
    if (error instanceof ApiCommandError) {
      if (error.exitCode === EXIT.invalidInput) {
        if (error.reason === 'password_rejected') {
          const [first] = messagesForIssues(error.passwordIssues);
          return { ok: false, errors: { password: first ?? TEXT.setup.failed } };
        }
        const fieldOf: Record<
          string,
          'organizationName' | 'ownerName' | 'ownerEmail' | 'password' | 'timeZone'
        > = {
          organizationName: 'organizationName',
          ownerName: 'ownerName',
          ownerEmail: 'ownerEmail',
          ownerPassword: 'password',
          timeZone: 'timeZone',
        };
        const errors: Partial<Record<string, string>> = {};
        for (const field of error.fields)
          errors[fieldOf[field] ?? 'organizationName'] = TEXT.setup.failed;
        return { ok: false, errors };
      }
      if (error.reason === 'email_in_use') {
        return { ok: false, errors: { ownerEmail: TEXT.setup.emailInUse } };
      }
    }
    this.log(`provision failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, message: TEXT.setup.failed };
  }

  // ---- the API and the worker -------------------------------------------------------------------

  private runtimeContext(apiPort: number): RuntimeContext {
    return {
      config: this.config,
      paths: this.deps.paths,
      databasePort: this.requireDatabasePort(),
      apiPort,
      serverPort: this.config.port,
    };
  }

  private makeSupervisor(role: LongRunningRole, context: RuntimeContext): Supervisor {
    const env = longRunningEnvironment(role, context);
    const log = role === 'api' ? this.deps.logs.api : this.deps.logs.worker;
    return new Supervisor({
      name: role,
      spawn: () => this.deps.spawnLongRunning(role, env),
      readiness:
        role === 'api'
          ? {
              kind: 'poll',
              probe: () => this.deps.probeHealth(context.apiPort),
              intervalMs: 250,
              timeoutMs: 90_000,
            }
          : { kind: 'line', pattern: /worker started/, timeoutMs: 90_000 },
      onOutput: (stream, line) => {
        log.write(`${stream === 'stderr' ? '[stderr] ' : ''}${line}\n`);
      },
      onState: (state, detail) => {
        this.onProcessState(role, state, detail);
      },
      log: (message) => {
        this.log(message);
      },
    });
  }

  private onProcessState(role: LongRunningRole, state: ProcessState, detail?: string): void {
    if (state !== 'failed' || this.reportedFailure || this.currentPhase === 'quitting') return;
    this.reportedFailure = true;
    this.log(`${role} failed: ${detail ?? ''}`);
    void this.deps.ui
      .choose({
        kind: 'error',
        title: TEXT.errors.title,
        message: TEXT.errors.service,
        buttons: [TEXT.errors.logs, TEXT.errors.quit],
      })
      .then(async (choice) => {
        if (choice === 0) await this.deps.ui.openPath(this.deps.paths.logs);
        else this.deps.requestQuit();
      });
  }

  private async startServices(): Promise<void> {
    const apiPort = await findFreePort();
    const context = this.runtimeContext(apiPort);
    this.reportedFailure = false;
    const api = this.makeSupervisor('api', context);
    const worker = this.makeSupervisor('worker', context);
    this.api = api;
    this.worker = worker;
    await Promise.all([api.start(), worker.start()]);
    this.apiPort = apiPort;
    this.log(`api on port ${String(apiPort)}, worker running`);
  }

  private async stopServices(): Promise<void> {
    this.apiPort = null;
    const { api, worker } = this;
    this.api = null;
    this.worker = null;
    await Promise.all([api?.stop(), worker?.stop()]);
  }

  private finishStart(options: { keepWindow?: boolean } = {}): void {
    this.setPhase('ready');
    if (options.keepWindow !== true) this.deps.ui.loadUrl(this.appUrl);
    void pruneOutbox(this.deps.paths.outbox, () => this.deps.now().getTime())
      .then((count) => {
        if (count > 0) this.log(`outbox: ${String(count)} old files deleted`);
      })
      .catch(() => undefined);
    void this.maybeDailyBackup();
    clearInterval(this.dailyTimer);
    this.dailyTimer = setInterval(() => {
      void this.maybeDailyBackup();
    }, HOUR_MS);
    this.dailyTimer.unref();
  }

  // ---- backups ----------------------------------------------------------------------------------

  private adoptionPayload(): AdoptionPayload {
    const { secrets, slug } = this.config;
    return {
      slug: slug ?? INSTALL_SLUG,
      kmsLocalKekBase64: secrets.kmsLocalKekBase64,
      addressHashPepper: secrets.addressHashPepper,
      storageUploadSecret: secrets.storageUploadSecret,
      recoveryKeyHash: secrets.recoveryKeyHash,
    };
  }

  private backupDeps() {
    return {
      paths: this.deps.paths,
      startDump: () =>
        this.deps.pgTools.dump(
          this.deps.resources.pgDump,
          [
            '--format=custom',
            '--host=127.0.0.1',
            `--port=${String(this.requireDatabasePort())}`,
            `--username=${SUPERUSER}`,
            `--dbname=${DATABASE_NAME}`,
            '--no-password',
          ],
          { ...osEnvironment(), PGPASSWORD: this.config.secrets.pgSuperuserPassword },
        ),
      backupKey: () => Buffer.from(this.config.secrets.backupKeyBase64, 'base64'),
      keyWrap: () => this.config.secrets.backupKeyWrap,
      secrets: () => this.adoptionPayload(),
      appVersion: this.deps.version,
      migrationCount: migrationCountOf(this.deps.resources),
      now: this.deps.now,
      log: (message: string) => {
        this.log(message);
      },
    };
  }

  /** Runs `work` unless a backup or a restore is running. A restore also keeps the owner's password from changing. */
  private async exclusive<T>(
    work: () => Promise<T>,
    kind: 'backup' | 'restore' = 'backup',
  ): Promise<T | 'busy'> {
    if (this.busy) return 'busy';
    this.busy = true;
    this.restoring = kind === 'restore';
    const running = work();
    this.inFlight = running.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await running;
    } finally {
      this.busy = false;
      this.restoring = false;
    }
  }

  /** The tray's "Hacer copia de seguridad". Returns the path of the backup, or `null` when it failed or could not start. */
  async backupNow(): Promise<string | null> {
    if (this.currentPhase !== 'ready') {
      await this.deps.ui.message('info', TEXT.backup.failed, TEXT.backup.notReady);
      return null;
    }
    const outcome = await this.exclusive(async () => {
      try {
        const result = await createBackup(this.backupDeps(), 'manual');
        await pruneBackups(this.deps.paths.backups);
        return result.path;
      } catch (error) {
        this.log(
          `backup failed: ${error instanceof BackupError ? `${error.message}: ${error.detail}` : String(error)}`,
        );
        return null;
      }
    });
    if (outcome === 'busy') return null;
    if (outcome === null) {
      await this.deps.ui.message('error', TEXT.backup.failed, TEXT.backup.failedBody);
      return null;
    }
    this.log(`backup created: ${outcome}`);
    await this.deps.ui.message('info', TEXT.backup.done, TEXT.backup.doneBody(outcome));
    return outcome;
  }

  /** The first time Consulvia is open on a day, and then every hour it stays open, until one backup of the day exists. */
  async maybeDailyBackup(): Promise<void> {
    if (this.currentPhase !== 'ready' || this.busy) return;
    const today = localDay(this.deps.now());
    if (this.config.settings.lastDailyBackup === today) return;
    await this.exclusive(async () => {
      try {
        const result = await createBackup(this.backupDeps(), 'daily');
        const pruned = await pruneBackups(this.deps.paths.backups);
        this.config = this.deps.store.update((config) => {
          config.settings.lastDailyBackup = today;
        });
        this.log(
          `daily backup created: ${result.path}${pruned.length > 0 ? `; ${String(pruned.length)} old ones deleted` : ''}`,
        );
      } catch (error) {
        this.log(`daily backup failed: ${error instanceof Error ? error.message : String(error)}`);
        if (this.lastDailyFailure !== today) {
          this.lastDailyFailure = today;
          this.deps.ui.notify(TEXT.backup.failed, TEXT.backup.dailyFailed);
        }
      }
    });
  }

  // ---- restore ----------------------------------------------------------------------------------

  private restoreDeps() {
    return {
      paths: this.deps.paths,
      backupKey: () => Buffer.from(this.config.secrets.backupKeyBase64, 'base64'),
      // As `app_owner`, not as the superuser: what a backup contains never runs with more power than the
      // application's own owner has.
      restoreDump: (source: Readable) =>
        this.deps.pgTools.restore(
          this.deps.resources.pgRestore,
          [
            '--host=127.0.0.1',
            `--port=${String(this.requireDatabasePort())}`,
            '--username=app_owner',
            `--dbname=${SCRATCH_DATABASE}`,
            '--no-owner',
            '--single-transaction',
            '--exit-on-error',
            '--no-password',
          ],
          { ...osEnvironment(), PGPASSWORD: this.config.secrets.appOwnerPassword },
          source,
        ),
      scratch: {
        create: () => this.cluster.createScratchDatabase(SCRATCH_DATABASE),
        swapIn: () => this.cluster.swapInDatabase(SCRATCH_DATABASE),
        drop: () => this.cluster.dropDatabase(SCRATCH_DATABASE),
      },
      migrationCount: migrationCountOf(this.deps.resources),
      stopServices: () => this.stopServices(),
      startServices: async () => {
        await this.deps.commands.migrate(
          migrateEnvironment({ config: this.config, databasePort: this.requireDatabasePort() }),
        );
        await this.startServices();
      },
      adoptSecrets: (adopted: AdoptedSecrets) => {
        this.config = this.deps.store.update((config) => {
          config.secrets.kmsLocalKekBase64 = adopted.payload.kmsLocalKekBase64;
          config.secrets.addressHashPepper = adopted.payload.addressHashPepper;
          config.secrets.storageUploadSecret = adopted.payload.storageUploadSecret;
          config.secrets.recoveryKeyHash = adopted.payload.recoveryKeyHash;
          config.secrets.backupKeyBase64 = adopted.backupKeyBase64;
          config.secrets.backupKeyWrap = adopted.backupKeyWrap;
          // The key that was typed is the key of this install now, and the owner just proved having it.
          config.secrets.recoveryKey = null;
          config.recoveryAcknowledged = true;
          config.slug = adopted.payload.slug;
        });
      },
      now: this.deps.now,
      log: (message: string) => {
        this.log(message);
      },
    };
  }

  private restoreMessage(error: unknown): string {
    if (error instanceof RestoreError) {
      switch (error.code) {
        case 'invalid_backup':
          return TEXT.restore.invalid;
        case 'tampered_backup':
          return TEXT.restore.tampered;
        case 'newer_version':
          return TEXT.restore.newerVersion;
        case 'wrong_recovery_key':
          return TEXT.restore.wrongKey;
        default:
          return TEXT.restore.generic;
      }
    }
    return TEXT.restore.generic;
  }

  /**
   * The tray's "Restaurar copia…": choose the file, confirm, make a safety backup, restore. The tests of
   * the installer pass the file themselves (`--restore=<file>`) and skip the confirmation.
   */
  async restoreFlow(file?: string): Promise<boolean> {
    if (this.currentPhase !== 'ready') {
      await this.deps.ui.message('info', TEXT.restore.failed, TEXT.backup.notReady);
      return false;
    }
    const archive =
      file ??
      (await this.deps.ui.pickFile({
        title: TEXT.restore.pickTitle,
        defaultPath: this.deps.paths.backups,
        filterName: TEXT.restore.pickFilter,
      }));
    if (archive === null) return false;
    let info;
    try {
      info = await readBackupInfo(archive);
    } catch (error) {
      await this.deps.ui.message('error', TEXT.restore.failed, this.restoreMessage(error));
      return false;
    }
    if (file === undefined || !this.deps.testMode) {
      const confirmed = await this.deps.ui.confirm({
        title: TEXT.restore.confirmTitle,
        message: TEXT.restore.confirmMessage,
        detail: TEXT.restore.confirmDetail(new Date(info.header.createdAt).toLocaleString('es-AR')),
        confirm: TEXT.restore.confirmButton,
        cancel: TEXT.restore.cancelButton,
      });
      if (!confirmed) return false;
    }
    const outcome = await this.exclusive(async () => {
      this.deps.ui.showSplash(TEXT.splash.restoring);
      try {
        const safety = await createBackup(this.backupDeps(), 'safety');
        this.log(`safety backup before restoring: ${safety.path}`);
        await restoreBackup(this.restoreDeps(), archive);
        return { ok: true as const };
      } catch (error) {
        if (error instanceof RestoreError && error.code === 'recovery_key_required') {
          return { ok: false as const, needsKey: true as const };
        }
        this.log(
          `restore failed: ${error instanceof RestoreError ? `${error.code}: ${error.detail}` : String(error)}`,
        );
        return { ok: false as const, needsKey: false as const, error };
      }
    }, 'restore');
    if (outcome === 'busy') return false;
    this.deps.ui.loadUrl(this.appUrl);
    if (outcome.ok) {
      this.log('restore finished');
      await this.deps.ui.message('info', TEXT.restore.done, TEXT.restore.doneBody);
      return true;
    }
    if (outcome.needsKey) {
      this.pendingRestore = { archive };
      const token = this.vault.issue(PURPOSE.key, 15 * 60_000);
      this.deps.ui.openAuxWindow(`${this.appUrl}/__key?t=${token}`, TEXT.recoveryKey.windowTitle);
      return false;
    }
    await this.deps.ui.message('error', TEXT.restore.failed, this.restoreMessage(outcome.error));
    return false;
  }

  // ---- the owner's password ---------------------------------------------------------------------

  openResetPassword(): void {
    if (this.currentPhase !== 'ready') {
      void this.deps.ui.message('info', TEXT.tray.resetPassword, TEXT.reset.notReady);
      return;
    }
    const token = this.vault.issue(PURPOSE.reset, 15 * 60_000);
    const url = `${this.appUrl}/__reset?t=${token}`;
    this.deps.ui.openAuxWindow(url, TEXT.reset.windowTitle);
    // Like the setup address: written down only for the tests of the installer, which fill the page from outside.
    if (this.deps.testMode) this.log(`reset url: ${url}`);
  }

  // ---- what the pages do ------------------------------------------------------------------------

  private commonPasswords(): ReadonlySet<string> {
    this.commonPasswordSet ??= loadCommonPasswordsSync(this.deps.resources.passwordList);
    return this.commonPasswordSet;
  }

  private pageActions(): PageActions {
    return {
      isProvisioned: () => this.loaded?.provisioned ?? false,
      commonPasswords: () => this.commonPasswords(),
      setup: (values) => this.runSetup(values),
      resetPassword: async (input) => {
        // A backup reads the database and does not mind; a restore is replacing it.
        if (this.restoring) return { ok: false, message: TEXT.reset.generic };
        const outcome = await (async () => {
          try {
            const context = this.runtimeContext(this.apiPort ?? 0);
            return await this.deps.commands.resetPassword(commandEnvironment(context), input);
          } catch (error) {
            return error instanceof Error ? error : new Error(String(error));
          }
        })();
        if (outcome instanceof ApiCommandError) {
          if (outcome.reason === 'password_rejected') {
            const [first] = messagesForIssues(outcome.passwordIssues);
            return { ok: false, errors: { password: first ?? TEXT.reset.generic } };
          }
          if (outcome.reason === 'owner_not_found')
            return { ok: false, message: TEXT.reset.noOwner };
          this.log(`reset-password failed: ${outcome.message}\n${outcome.stderr}`);
          return { ok: false, message: TEXT.reset.generic };
        }
        if (outcome instanceof Error) {
          this.log(`reset-password failed: ${outcome.message}`);
          return { ok: false, message: TEXT.reset.generic };
        }
        this.log('the password of the owner was reset');
        return { ok: true, email: outcome.email, secondFactorCleared: outcome.secondFactorCleared };
      },
      submitRecoveryKey: async (key) => {
        const pending = this.pendingRestore;
        if (!pending) return { ok: false, message: TEXT.restore.generic };
        const outcome = await this.exclusive(async () => {
          this.deps.ui.showSplash(TEXT.splash.restoring);
          try {
            await restoreBackup(this.restoreDeps(), pending.archive, { recoveryKey: key });
            return null;
          } catch (error) {
            return error;
          }
        }, 'restore');
        if (outcome === 'busy') return { ok: false, message: TEXT.restore.generic };
        this.deps.ui.loadUrl(this.appUrl);
        if (outcome === null) {
          this.pendingRestore = null;
          this.vault.revoke(PURPOSE.key);
          this.deps.ui.closeAuxWindow();
          await this.deps.ui.message('info', TEXT.restore.done, TEXT.restore.doneBody);
          return { ok: true };
        }
        this.log(
          `restore with a recovery key failed: ${outcome instanceof RestoreError ? outcome.code : describeError(outcome).detail}`,
        );
        return { ok: false, message: this.restoreMessage(outcome) };
      },
    };
  }

  // ---- the tray ---------------------------------------------------------------------------------

  openApp(): void {
    this.deps.ui.showMainWindow();
  }

  openInBrowser(): void {
    if (this.currentPhase === 'ready') this.deps.ui.openExternal(this.appUrl);
  }

  async openOutbox(): Promise<void> {
    await mkdir(this.deps.paths.outbox, { recursive: true });
    await this.deps.ui.openPath(this.deps.paths.outbox);
  }

  async openLogs(): Promise<void> {
    await this.deps.ui.openPath(this.deps.paths.logs);
  }

  toggleAutoStart(): void {
    if (!this.loaded) return;
    const enabled = !this.loaded.settings.autoStart;
    this.config = this.deps.store.update((config) => {
      config.settings.autoStart = enabled;
    });
    this.deps.ui.setAutoStart(enabled);
    this.changed();
  }

  /** Applies the stored auto-start setting to Windows (a moved or reinstalled app registers itself again). */
  syncAutoStart(): void {
    if (this.loaded) this.deps.ui.setAutoStart(this.loaded.settings.autoStart);
  }

  async showRecoveryKey(): Promise<void> {
    const key = this.loaded?.secrets.recoveryKey;
    if (!key) {
      await this.deps.ui.message('info', TEXT.recoveryKey.title, TEXT.recoveryKey.gone);
      return;
    }
    const choice = await this.deps.ui.choose({
      kind: 'info',
      title: TEXT.recoveryKey.title,
      message: `${TEXT.recoveryKey.message}\n\n${key}`,
      detail: TEXT.recoveryKey.detail,
      buttons: [TEXT.recoveryKey.copy, TEXT.recoveryKey.close],
    });
    if (choice === 0) this.deps.ui.copyToClipboard(key);
  }

  async about(): Promise<void> {
    await this.deps.ui.message(
      'info',
      TEXT.about.title,
      TEXT.appName,
      TEXT.about.detail(this.deps.version, this.deps.paths.root, this.deps.paths.backups),
    );
  }

  markTrayHintShown(): void {
    if (!this.loaded) return;
    this.config = this.deps.store.update((config) => {
      config.settings.trayHintShown = true;
    });
  }

  // ---- quit -------------------------------------------------------------------------------------

  private async stopEverything(): Promise<void> {
    await this.stopServices();
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
    await this.clusterOrNull?.stop();
  }

  /** Stops the API and the worker, then the local server, then the database; resolves when nothing of the install runs. */
  quit(): Promise<void> {
    this.quitPromise ??= (async () => {
      this.setPhase('quitting');
      clearInterval(this.dailyTimer);
      // A start that is still running finishes (or fails) first, so nothing is left half started.
      await this.bootRun.catch(() => undefined);
      await this.inFlight;
      try {
        await this.stopEverything();
      } catch (error) {
        this.log(`error while quitting: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.log('stopped');
    })();
    return this.quitPromise;
  }
}
