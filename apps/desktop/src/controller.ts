import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
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
import { readArchiveHeader } from './backup-archive.js';
import { verifyRecoveryKey, keyIdOf } from './backup-crypto.js';
import { readLedger } from './backup-ledger.js';
import {
  adoptUnledgeredBackups,
  unledgeredBackups,
  BackupError,
  createBackup,
  localDay,
  pruneBackups,
  type AdoptionPayload,
} from './backup.js';
import { isCloudSynced } from './cloud-folders.js';
import {
  ConfigError,
  newInstallConfig,
  type ConfigStore,
  type InstallConfig,
} from './config-store.js';
import { DiskFullError, directoryBytes, isDiskFull } from './disk.js';
import {
  createInternalPages,
  PURPOSE,
  type ConfirmOutcome,
  type PageActions,
  type RegenerateOutcome,
  type ResetOutcome,
  type SetupOutcome,
} from './internal-pages.js';
import { createLocalServer, loadContentSecurityPolicy, type LocalServer } from './local-server.js';
import { pruneOutbox } from './outbox.js';
import { type OwnerCheck, type OwnerCheckOptions } from './owner-check.js';
import { loadCommonPasswordsSync, messagesForIssues } from './password-check.js';
import type { DataPaths } from './paths.js';
import { chooseServerPort, findFreePort, type PortRetry } from './ports.js';
import {
  DATABASE_NAME,
  type PostgresCluster,
  PostgresError,
  type RestoreScratch,
  SUPERUSER,
} from './postgres.js';
import { normalizeRecoveryKey } from './recovery-key.js';
import { redact } from './redact.js';
import { migrationCountOf, missingResources, type Resources } from './resources.js';
import { auditProblems, revertStatements, type ClusterFacts } from './restore-audit.js';
import {
  journalFile,
  readJournal,
  reconcileInterruptedRestore,
  RESTORE_WORK_FILES,
  type ReconcileDeps,
} from './restore-journal.js';
import {
  readBackupInfo,
  restoreBackup,
  RestoreError,
  type AdoptedSecrets,
  type ScratchHandle,
} from './restore.js';
import { parameterizeRolesScript } from './roles.js';
import type { RotatingLog } from './rotating-log.js';
import { generateSecrets, newRecoveryKey, type FreshRecoveryKey } from './secrets.js';
import { INSTALL_SLUG, type SetupValues } from './setup-validation.js';
import type { PgTools } from './streams.js';
import { TEXT } from './strings.js';
import { Supervisor, type ChildLike, type ProcessState } from './supervisor.js';
import { TokenVault } from './tokens.js';
import type { Credentials } from './window-proof.js';

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
  /**
   * True when what listens on this port is the API of this run: it answers `GET /health` with 200 and with
   * the proof that it holds `secret`. A bare 200 would also come from any program that took the port.
   */
  probeHealth: (port: number, secret: string) => Promise<boolean>;
  createCluster: (secrets: InstallConfig['secrets']) => PostgresCluster;
  /** Signs in through the API to prove that whoever asks is an owner (see `owner-check.ts`). */
  verifyOwner: (options: OwnerCheckOptions) => Promise<OwnerCheck>;
  logs: { shell: RotatingLog; api: RotatingLog; worker: RotatingLog };
  /** The tests of the installer drive the app from outside; some conveniences exist only then. */
  testMode: boolean;
  /** The waits before the API and the worker are started again after they die. Defaults to 1 s, then 2 s. */
  supervisorBackoffMs?: number[];
  /** The environment of the shell, to know which folders Windows syncs. Defaults to nothing. */
  env?: NodeJS.ProcessEnv;
  /** How long the stored port of the local server is waited for. Tests do not wait. */
  portRetry?: PortRetry;
  now: () => Date;
  /** Leaves the program (the dialogs ask for it). The caller ends with `quit()`. */
  requestQuit: () => void;
}

/** What the API of one run of the services needs to know, and what the local server learns from it. */
interface ServiceRun {
  /** The port the API listens on now. It changes if the API has to be launched again. */
  apiPort: number;
  /** The secret the API demands of every request; random for each run. */
  secret: string;
}

/** A failure whose message for the user is already known. */
export class ShellError extends Error {
  constructor(
    readonly userMessage: string,
    detail: string,
    /** The data of this install cannot be opened, so the only way on is a new install and a restore. */
    readonly deadEnd = false,
    /** The person may choose to go on without the safety copy that could not be made. */
    readonly canSkipBackup = false,
  ) {
    super(detail);
    this.name = 'ShellError';
  }
}

/** Failures that retrying cannot fix: the secrets or the database of this install are gone for this account. */
function isDeadEnd(error: unknown): boolean {
  if (error instanceof ConfigError) {
    return error.code === 'cannot_decrypt' || error.code === 'unreadable';
  }
  return error instanceof ShellError && error.deadEnd;
}

const MINUTE_MS = 60 * 1000;

/** How often the database server is asked whether it is alive. */
const DATABASE_CHECK_MS = 30 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Wrong recovery keys the reset page accepts before its address stops working. */
const MAX_RESET_ATTEMPTS = 5;

/** How often the person is reminded to copy the backups off this PC. */
const COPY_REMINDER_MS = 30 * 24 * HOUR_MS;

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
const REPEATED_FAILURES = 3;

/** What makes two failures the same one: what the person is told, or the kind and the words of the error. */
function failureSignature(error: unknown): string {
  if (error instanceof ShellError) return `shell:${error.userMessage}`;
  if (error instanceof Error) return `${error.name}:${error.message.slice(0, 120)}`;
  return String(error);
}

export class Controller {
  private loaded: InstallConfig | null = null;
  private clusterOrNull: PostgresCluster | null = null;
  private server: LocalServer | null = null;
  private apiPort: number | null = null;
  /** The secret of this run, known to the local server and the API only; null while the API is down. */
  private proxySecret: string | null = null;
  /** The person chose to update the database without the safety copy; good for the next start only. */
  private skipUpgradeBackup = false;
  /** Starts that failed one after the other: a start that works resets it. */
  private failures = 0;
  /** How many of them failed in the same way as the last one. */
  private sameFailures = 0;
  private lastFailure: string | null = null;
  /**
   * The recovery key between the setup that made it and the owner's confirmation. Memory only: it is never written
   * to this PC, and a restart forgets it (the owner then confirms by typing the key from their paper copy).
   */
  private pendingRecoveryKey: string | null = null;
  /** The data of the setup form and the key that was shown for it, until the owner confirms the key. */
  private pendingSetup: { values: SetupValues; fresh: FreshRecoveryKey } | null = null;
  /** A new key for an install that never confirmed one, shown and not yet confirmed. */
  private pendingRegeneration: FreshRecoveryKey | null = null;
  private regenerateAttempts = 0;
  private api: Supervisor | null = null;
  private worker: Supervisor | null = null;
  private readonly vault = new TokenVault();
  /** What proves a request comes from a window of the shell (see `window-proof.ts`): new in every run. */
  private readonly credentials: Credentials = {
    window: randomBytes(32).toString('base64url'),
    browser: randomBytes(32).toString('base64url'),
  };
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
  private databaseTimer: NodeJS.Timeout | undefined;
  /** Pings in a row that the database did not answer. */
  private databaseMisses = 0;
  private lastDailyFailure: string | null = null;
  private commonPasswordSet: ReadonlySet<string> | null = null;
  /** The restore that is waiting for its keys: which file, and which keys it asked for. */
  private pendingRestore: { archive: string; needsCurrent: boolean; needsBackup: boolean } | null =
    null;
  private restoreAttempts = 0;
  /** A new install after "start over": the restore is offered as soon as it is up. */
  private offerRestoreAfterBoot = false;
  /** Where data without a configuration was set aside at this start, to tell the person. */
  private orphanedTo: string[] = [];
  /** Failed attempts at today's backup, and the time before which another one is not tried. */
  private dailyFailures = 0;
  private nextDailyAttempt = 0;
  /** The port the local server had before this start, when it had to move: links already sent name it. */
  private movedFromPort: number | null = null;
  /** Wrong recovery keys typed on the reset page that is open. */
  private resetAttempts = 0;
  /** Wrong tails of the recovery key typed on the page that confirms it, and wrong keys typed to check it. */
  private keyPageAttempts = 0;
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

  /** The value that the windows of the shell send with every request to the local server. */
  get windowProof(): string {
    return this.credentials.window;
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
    this.deps.logs.shell.write(`${this.deps.now().toISOString()} ${redact(message)}\n`);
  }

  // ---- start ------------------------------------------------------------------------------------

  /** Starts the install. Never rejects: a failure is shown to the user and leaves the controller in `error`. */
  start(): Promise<void> {
    this.bootRun = this.boot().then(() => {
      this.failures = 0;
      this.sameFailures = 0;
      this.lastFailure = null;
    });
    return this.bootRun.catch((error: unknown) => {
      this.failures += 1;
      // The same failure, one start after another: what a retry will not fix.
      const signature = failureSignature(error);
      this.sameFailures = signature === this.lastFailure ? this.sameFailures + 1 : 1;
      this.lastFailure = signature;
      return this.fail(error);
    });
  }

  private async fail(error: unknown, moreOptions = false): Promise<void> {
    if (this.isQuitting()) return;
    const { message, detail } = describeError(error);
    this.log(`startup failed: ${detail}`);
    this.setPhase('error');
    this.deps.ui.showSplash(message, false);
    // The way out (start over and restore a copy) is offered by itself when the data cannot be opened, or when
    // the same failure came three starts in a row. After three failures of different kinds it waits behind "more
    // options": something that changes between the tries is not known to be the data.
    const offerStartOver =
      isDeadEnd(error) || this.sameFailures >= REPEATED_FAILURES || moreOptions;
    const offerMore = !offerStartOver && this.failures >= REPEATED_FAILURES;
    // After a retry that failed for the same reason, the safety copy before an update may be given up.
    const canSkip = error instanceof ShellError && error.canSkipBackup && this.failures >= 2;
    const buttons = [
      TEXT.errors.retry,
      TEXT.errors.logs,
      ...(offerMore ? [TEXT.errors.moreOptions] : []),
      ...(offerStartOver ? [TEXT.errors.startOver] : []),
      ...(canSkip ? [TEXT.errors.continueWithoutCopy] : []),
      TEXT.errors.quit,
    ];
    const choice = await this.deps.ui.choose({
      kind: 'error',
      title: TEXT.errors.title,
      message,
      buttons,
    });
    if (this.isQuitting()) return;
    const picked = buttons[choice];
    if (choice === 1) {
      await this.deps.ui.openPath(this.deps.paths.logs);
      await this.fail(error, moreOptions);
    } else if (picked === TEXT.errors.moreOptions) {
      await this.fail(error, true);
    } else if (choice === 0) {
      await this.stopQuietly();
      await this.start();
    } else if (picked === TEXT.errors.startOver) {
      if (!(await this.startOver())) await this.fail(error, moreOptions);
    } else if (picked === TEXT.errors.continueWithoutCopy) {
      if (!(await this.confirmUpgradeWithoutCopy())) {
        await this.fail(error, moreOptions);
        return;
      }
      this.skipUpgradeBackup = true;
      await this.stopQuietly();
      await this.start();
    } else {
      this.deps.requestQuit();
    }
  }

  /**
   * The way out of an install whose secrets or database cannot be opened: the configuration, the database and
   * the documents are moved aside (never deleted), a new empty install starts, and a restore is offered.
   * `electron-profile` is not touched: the key that protects the secrets lives in it. Returns false when the
   * person says no or nothing could be moved, and then nothing has changed.
   */
  private async startOver(): Promise<boolean> {
    const stamp = String(this.deps.now().getTime());
    const confirmed = await this.deps.ui.confirm({
      title: TEXT.startOver.confirmTitle,
      message: TEXT.startOver.confirmMessage,
      detail: TEXT.startOver.confirmDetail(stamp),
      confirm: TEXT.startOver.confirmButton,
      cancel: TEXT.startOver.cancelButton,
    });
    if (!confirmed || this.isQuitting()) return false;
    await this.stopQuietly();
    const { configFile, pgdata, files } = this.deps.paths;
    const moved: [string, string][] = [];
    try {
      for (const path of [
        configFile,
        `${configFile}.bak`,
        pgdata,
        files,
        ...(await this.restoreLeftovers()),
      ]) {
        try {
          await rename(path, `${path}.aside-${stamp}`);
          moved.push([path, `${path}.aside-${stamp}`]);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      this.log(
        `could not set the data aside: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Put back what was already moved: either everything moves or nothing does.
      for (const [from, to] of moved.reverse()) await rename(to, from).catch(() => undefined);
      await this.deps.ui.message('error', TEXT.startOver.confirmTitle, TEXT.startOver.failed);
      return false;
    }
    this.log(`data set aside to start over: ${moved.map(([, to]) => to).join(', ')}`);
    this.loaded = null;
    this.clusterOrNull = null;
    this.server = null;
    this.offerRestoreAfterBoot = true;
    this.failures = 0;
    this.sameFailures = 0;
    await this.start();
    return true;
  }

  /**
   * What an interrupted restore leaves in the data folder: its record and everything the record names, and the work
   * files that carry its name. They go aside with the rest: left in place, the new install would act on a record that
   * is not about it, or sweep the old documents that wait there.
   */
  private async restoreLeftovers(): Promise<string[]> {
    const { root } = this.deps.paths;
    const found = new Set<string>([journalFile(this.deps.paths)]);
    const journal = await readJournal(this.deps.paths);
    if (journal !== null && journal !== 'unreadable') {
      for (const path of [journal.filesAside, journal.unpacked, journal.configCopy]) {
        // Only what is inside the data folder: a record is not trusted to point anywhere else.
        if (path !== null && path.startsWith(`${root}${sep}`)) found.add(path);
      }
    }
    for (const name of await readdir(root).catch(() => [])) {
      if (RESTORE_WORK_FILES.test(name)) found.add(join(root, name));
    }
    return [...found];
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
    await this.reconcileRestore();
    // Only now: a folder created before the restore was reconciled would look like the restored one.
    await mkdir(paths.files, { recursive: true });
    await mkdir(paths.outbox, { recursive: true });

    await this.guardMigrations();
    await this.migrateDatabase();
    this.log('migrations applied');

    if (!this.config.provisioned) {
      this.beginSetup();
      this.announceNotices();
      if (this.offerRestoreAfterBoot) {
        this.offerRestoreAfterBoot = false;
        void this.restoreFlow();
      }
      return;
    }
    await this.startServices();
    this.finishStart();
    this.announceNotices();
  }

  /** Tells the person once that the address of the program changed, because links in older emails stop working. */
  private announceNotices(): void {
    const from = this.movedFromPort;
    this.movedFromPort = null;
    if (from !== null) {
      void this.deps.ui.message(
        'info',
        TEXT.port.movedTitle,
        TEXT.port.moved(from, this.config.port),
      );
    }
    const orphaned = this.orphanedTo;
    this.orphanedTo = [];
    if (orphaned.length > 0) {
      void this.deps.ui.message('info', TEXT.orphaned.title, TEXT.orphaned.body(orphaned));
    }
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
        // The damaged file is kept aside first: writing over it would copy it onto the good previous copy.
        const kept = store.quarantine(String(this.deps.now().getTime()));
        store.write(this.config);
        this.log(
          `config.json was damaged (kept as ${kept ?? 'nothing'}); restored from config.json.bak`,
        );
      }
    } else {
      const recovered = this.readPreviousConfig();
      if (recovered !== null) {
        // The file went missing but the previous good copy is there: the keys are not lost.
        this.config = recovered;
        store.write(this.config);
        this.log('config.json was missing; restored from config.json.bak');
      } else {
        await this.createFreshConfig();
      }
    }
    this.commonPasswordSet = null;
    this.scrubStoredRecoveryKey();
  }

  /**
   * An earlier build kept the recovery key in the configuration until it was confirmed. It is moved to memory (so
   * the owner can still confirm it in this run) and taken off the disk.
   */
  private scrubStoredRecoveryKey(): void {
    const stored = this.config.secrets.recoveryKey;
    if (stored === null) return;
    if (!this.config.recoveryAcknowledged) this.pendingRecoveryKey = stored;
    this.config = this.deps.store.update((config) => {
      config.secrets.recoveryKey = null;
    });
    this.log('a recovery key kept by an earlier version was removed from the configuration');
  }

  /** The configuration kept as `config.json.bak`, or null when there is none or it is not readable at all. */
  private readPreviousConfig(): InstallConfig | null {
    const previous = this.deps.store.previous();
    if (!previous.exists()) return null;
    try {
      return previous.read();
    } catch (error) {
      // Another Windows account (or no cipher) is a dead end the person has to hear about, not a missing file.
      if (error instanceof ConfigError && error.code === 'unreadable') return null;
      throw error;
    }
  }

  /**
   * A data folder without its configuration cannot be opened: the keys died with the file. It is set aside,
   * never deleted, in case the configuration comes back, and the person is told where it went.
   */
  private async createFreshConfig(): Promise<void> {
    this.orphanedTo = await this.setAsideOrphanedData();
    const port = await chooseServerPort(null);
    this.config = newInstallConfig(port, generateSecrets());
    this.config.slug = INSTALL_SLUG;
    this.deps.store.write(this.config);
    this.log('new install configured');
  }

  private async setAsideOrphanedData(): Promise<string[]> {
    const { pgdata, files } = this.deps.paths;
    const stamp = String(this.deps.now().getTime());
    const moved: string[] = [];
    for (const folder of [pgdata, files]) {
      try {
        await rename(folder, `${folder}.orphaned-${stamp}`);
        moved.push(`${folder}.orphaned-${stamp}`);
        this.log(`set aside data without a configuration: ${folder}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return moved;
  }

  private async startLocalServer(): Promise<void> {
    const { resources } = this.deps;
    const port = await chooseServerPort(
      this.config.port,
      undefined,
      undefined,
      this.deps.portRetry,
    );
    if (port !== this.config.port) {
      this.movedFromPort = this.config.port;
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
      proxySecret: () => this.proxySecret,
      pages: createInternalPages(this.vault, this.pageActions()),
      credentials: this.credentials,
      log: (message) => {
        this.log(message);
      },
    });
    await this.server.listen();
    // The tests of the installer drive the program from outside, as the window would; they need the proof.
    if (this.deps.testMode) this.log(`window proof: ${this.credentials.window}`);
    this.log(`local server on 127.0.0.1:${String(port)}`);
  }

  private requireDatabasePort(): number {
    const port = this.cluster.runningPort;
    if (port === null) throw new PostgresError('the database server is not running');
    return port;
  }

  /**
   * Before the migrations run: a database from a NEWER version is not opened by this one (a downgrade would
   * read it wrongly), and a database from an older one gets a verified backup first, because a migration
   * that fails half way is not undone.
   */
  private async guardMigrations(): Promise<void> {
    const applied = await this.cluster.appliedMigrationCount();
    if (applied === null) return;
    const bundled = migrationCountOf(this.deps.resources);
    if (applied > bundled) {
      throw new ShellError(
        TEXT.errors.downgrade,
        `the database has ${String(applied)} migrations and this version knows ${String(bundled)}`,
      );
    }
    if (applied === bundled || !this.config.provisioned) return;
    if (this.skipUpgradeBackup) {
      this.skipUpgradeBackup = false;
      this.log('updating the database without a safety copy, as the person chose');
      return;
    }
    this.deps.ui.showSplash(TEXT.splash.upgradeBackup);
    try {
      const backup = await createBackup(this.backupDeps(), 'upgrade');
      this.log(`backup before the update of the database: ${backup.path}`);
      await this.pruneQuietly();
    } catch (error) {
      // The copy made now is the one that is wanted. When it cannot be made (a full disk, a dump that fails), a
      // verified copy of the last day by when it was MADE stands in for it, so that one failure does not keep the
      // program from being updated for good.
      const recent = await this.recentVerifiedBackup();
      if (recent !== null) {
        this.log(
          `the backup before the update failed (${this.describeBackupFailure(error)}); using a verified backup of the last day instead: ${recent}`,
        );
        return;
      }
      throw new ShellError(
        TEXT.errors.upgradeBackup,
        `the backup before the update failed: ${this.describeBackupFailure(error)}`,
        false,
        true,
      );
    }
  }

  /** The name of a backup that was MADE in the last 24 hours, was verified, and is still there, or null. */
  private async recentVerifiedBackup(): Promise<string | null> {
    const { backups } = this.deps.paths;
    const since = this.deps.now().getTime() - DAY_MS;
    const ledger = await readLedger(backups);
    for (const name of Object.keys(ledger)) {
      // When it was made is in its header, not in the ledger (which says when it was last verified).
      const madeAt = await readArchiveHeader(join(backups, name)).then(
        (found) => Date.parse(found.header.createdAt),
        () => Number.NaN,
      );
      if (!Number.isNaN(madeAt) && madeAt >= since) return name;
    }
    return null;
  }

  private async confirmUpgradeWithoutCopy(): Promise<boolean> {
    return this.deps.ui.confirm({
      title: TEXT.upgradeWithoutCopy.confirmTitle,
      message: TEXT.upgradeWithoutCopy.confirmMessage,
      detail: TEXT.upgradeWithoutCopy.confirmDetail,
      confirm: TEXT.upgradeWithoutCopy.confirmButton,
      cancel: TEXT.upgradeWithoutCopy.cancelButton,
    });
  }

  /**
   * Runs the migrations. `app_owner` holds the right to hand out `audit_sealer` only for the time a migration that is
   * pending needs it (migration 0020 takes the membership the bootstrap gave `app_rw` away): the rest of the time
   * it is not there for a statement of a restored dump, or of anything else that runs as `app_owner`, to use.
   */
  private async migrateDatabase(): Promise<void> {
    const applied = await this.cluster.appliedMigrationCount();
    const pending = applied === null || applied < migrationCountOf(this.deps.resources);
    if (pending) await this.cluster.setOwnerAuditAdmin(true);
    try {
      await this.deps.commands.migrate(
        migrateEnvironment({ config: this.config, databasePort: this.requireDatabasePort() }),
      );
    } finally {
      try {
        await this.cluster.setOwnerAuditAdmin(false);
      } catch (error) {
        this.log(
          `could not take the right to hand out audit_sealer away from app_owner: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** A restore that was cut off (a power cut, a crash) is finished or undone before anything uses the database. */
  private async reconcileRestore(): Promise<void> {
    const outcome = await reconcileInterruptedRestore(this.reconcileDeps());
    // A record that cannot be read is a restore of which nothing is known: starting on top of it could do what
    // the restore was in the middle of a second time, or hide it. The start waits for a retry.
    if (outcome === 'unreadable') {
      throw new ShellError(TEXT.errors.restoreJournal, 'restore-journal.json cannot be read');
    }
    if (outcome !== 'none') this.log(`restore reconciled at start: ${outcome}`);
  }

  private reconcileDeps(): ReconcileDeps {
    return {
      paths: this.deps.paths,
      databases: {
        names: () => this.cluster.listDatabases(),
        rename: (from, to) => this.cluster.renameDatabase(from, to),
        drop: (name) => this.cluster.dropDatabase(name),
        dropRestoreRoles: () => this.cluster.dropRestoreRoles(),
      },
      reloadConfig: () => {
        this.config = this.deps.store.read();
      },
      log: (message) => {
        this.log(message);
      },
    };
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
    if (!this.cluster.isInitialized()) {
      throw new ShellError(
        TEXT.errors.dataMissing,
        `pgdata is missing: ${this.deps.paths.pgdata}`,
        true,
      );
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

  /**
   * The first step of the setup: the data of the form is checked and kept in memory, and the recovery key is made and
   * shown. NOTHING is created yet. The key is the one thing that cannot be shown again, so it is shown first, and the
   * organization is created only when the owner has typed its last four characters on that same page
   * (`completeSetup`). A window or a program that closes in between leaves nothing behind: the next start asks again,
   * with a new key.
   */
  private runSetup(values: SetupValues): Promise<SetupOutcome> {
    if (this.setupRunning || this.config.provisioned) {
      return Promise.resolve({ ok: false, message: TEXT.setup.busy });
    }
    const fresh = newRecoveryKey(this.config.secrets.backupKeyBase64);
    this.pendingSetup = { values, fresh };
    this.keyPageAttempts = 0;
    return Promise.resolve({
      ok: true,
      recoveryKey: fresh.recoveryKey,
      ackToken: this.vault.issue(PURPOSE.ack, 24 * HOUR_MS),
    });
  }

  /**
   * The second step: the owner typed the end of the key they were shown. Only now the install is wrapped with it
   * (nothing was backed up yet, so nothing is wrapped with another key), the organization is created and the
   * services start.
   */
  private async completeSetup(
    setup: { values: SetupValues; fresh: FreshRecoveryKey },
    lastFour: string,
  ): Promise<ConfirmOutcome> {
    if (
      normalizeRecoveryKey(lastFour) !== normalizeRecoveryKey(setup.fresh.recoveryKey).slice(-4)
    ) {
      return this.keyPageMiss(PURPOSE.ack, 'recoveryKeyLast4', TEXT.recoveryKey.wrongLast4);
    }
    if (this.setupRunning || this.config.provisioned) {
      return { ok: false, message: TEXT.setup.busy };
    }
    this.setupRunning = true;
    const { values, fresh } = setup;
    try {
      this.config = this.deps.store.update((config) => {
        config.secrets.backupKeyWrap = fresh.backupKeyWrap;
        config.secrets.recoveryKeyHash = fresh.recoveryKeyHash;
        config.secrets.recoveryKey = null;
        config.recoveryAcknowledged = true;
      });
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
        // What the API refused is a thing to change in the form: back to it, and the key is made anew.
        this.pendingSetup = null;
        const failure = this.setupFailure(error);
        return failure.ok
          ? { ok: false, message: TEXT.setup.failed, back: true }
          : { ...failure, back: true };
      }
      this.pendingSetup = null;
      this.config = this.deps.store.update((config) => {
        config.provisioned = true;
        // The reminders to copy the backups off this PC start counting now.
        config.settings.lastCopyReminder = this.deps.now().toISOString();
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
      this.vault.revoke(PURPOSE.ack);
      this.finishStart({ keepWindow: true });
      this.log('the recovery key was confirmed by the owner before the organization was created');
      return { ok: true };
    } catch (error) {
      this.log(`setup failed: ${describeError(error).detail}`);
      return { ok: false, message: describeError(error).message, back: true };
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

  private makeSupervisor(role: LongRunningRole, run: ServiceRun): Supervisor {
    const context = this.runtimeContext(0);
    const log = role === 'api' ? this.deps.logs.api : this.deps.logs.worker;
    return new Supervisor({
      name: role,
      ...(this.deps.supervisorBackoffMs ? { backoffMs: this.deps.supervisorBackoffMs } : {}),
      // The port is chosen at every launch: one that was taken between the choice and the bind is not tried again.
      ...(role === 'api'
        ? {
            prepare: async () => {
              run.apiPort = await findFreePort();
            },
          }
        : {}),
      spawn: () =>
        this.deps.spawnLongRunning(
          role,
          longRunningEnvironment(role, {
            ...context,
            apiPort: run.apiPort,
            proxySecret: run.secret,
          }),
        ),
      readiness:
        role === 'api'
          ? {
              kind: 'poll',
              probe: () => this.deps.probeHealth(run.apiPort, run.secret),
              intervalMs: 250,
              timeoutMs: 90_000,
            }
          : { kind: 'line', pattern: /worker started/, timeoutMs: 90_000 },
      onOutput: (stream, line) => {
        log.write(`${stream === 'stderr' ? '[stderr] ' : ''}${line}\n`);
      },
      onState: (state, detail) => {
        if (role === 'api') this.followApi(state, run);
        this.onProcessState(role, state, detail);
      },
      log: (message) => {
        this.log(message);
      },
    });
  }

  private onProcessState(role: LongRunningRole, state: ProcessState, detail?: string): void {
    if (state !== 'failed' || this.reportedFailure) return;
    this.log(`${role} failed: ${detail ?? ''}`);
    // While the program is starting, or an operation of the tray is running, whoever started the process
    // reports its failure: a second dialog from here would be the same news twice.
    if (this.currentPhase !== 'ready' || this.busy) return;
    this.reportedFailure = true;
    void this.runtimeFailureDialog();
  }

  /** A process died for good while the program was working: say so, and let the person try again. */
  private async runtimeFailureDialog(): Promise<void> {
    const choice = await this.deps.ui.choose({
      kind: 'error',
      title: TEXT.errors.title,
      message: TEXT.errors.service,
      buttons: [TEXT.errors.retry, TEXT.errors.logs, TEXT.errors.quit],
    });
    if (this.isQuitting()) return;
    if (choice === 0) {
      await this.retryServices();
    } else if (choice === 1) {
      await this.deps.ui.openPath(this.deps.paths.logs);
      await this.runtimeFailureDialog();
    } else {
      this.deps.requestQuit();
    }
  }

  /** Stops and starts the API and the worker again. Nothing else is touched. */
  private async retryServices(): Promise<void> {
    const outcome = await this.exclusive(
      async () => {
        try {
          await this.stopServices();
          await this.startServices();
          return null;
        } catch (error) {
          return error;
        }
      },
      'backup',
      true,
    );
    if (outcome !== 'busy' && outcome !== null) {
      this.reportedFailure = true;
      void this.fail(outcome);
    }
  }

  /**
   * Called every half minute: asks the database server whether it is alive. Two misses in a row (one can be a slow
   * moment) and it is started again, with the API and the worker, which hold connections to the old one.
   */
  async checkDatabase(): Promise<void> {
    if (this.currentPhase !== 'ready' || this.busy || !this.clusterOrNull) return;
    if (await this.cluster.ping()) {
      this.databaseMisses = 0;
      return;
    }
    this.databaseMisses += 1;
    this.log(`the database did not answer (${String(this.databaseMisses)} in a row)`);
    if (this.databaseMisses < 2) return;
    this.databaseMisses = 0;
    const outcome = await this.exclusive(
      async () => {
        try {
          this.log('the database server is not answering: starting it again');
          await this.stopServices();
          await this.cluster.stop().catch((error: unknown) => {
            this.log(`stopping the database server failed: ${String(error)}`);
          });
          await this.cluster.start();
          await this.startServices();
          return null;
        } catch (error) {
          return error;
        }
      },
      'backup',
      true,
    );
    if (outcome !== 'busy' && outcome !== null) {
      this.reportedFailure = true;
      void this.fail(outcome);
    }
  }

  /** The local server forwards to the API only while it is running, and under its port of the moment. */
  private followApi(state: ProcessState, run: ServiceRun): void {
    if (state === 'running') {
      this.apiPort = run.apiPort;
      this.proxySecret = run.secret;
    } else {
      this.apiPort = null;
      this.proxySecret = null;
    }
  }

  private async startServices(): Promise<void> {
    // New for every start of the services: nothing a previous run learned is worth anything now.
    const run: ServiceRun = { apiPort: 0, secret: randomBytes(32).toString('hex') };
    this.reportedFailure = false;
    const api = this.makeSupervisor('api', run);
    const worker = this.makeSupervisor('worker', run);
    this.api = api;
    this.worker = worker;
    await Promise.all([api.start(), worker.start()]);
    this.apiPort = run.apiPort;
    this.proxySecret = run.secret;
    this.log(`api on port ${String(run.apiPort)}, worker running`);
  }

  private async stopServices(): Promise<void> {
    this.apiPort = null;
    this.proxySecret = null;
    const { api, worker } = this;
    this.api = null;
    this.worker = null;
    await Promise.all([api?.stop(), worker?.stop()]);
  }

  private finishStart(options: { keepWindow?: boolean } = {}): void {
    // A page that asks for the keys of a restore, opened while the install was still waiting for its setup, asked
    // for no key of this install because there was nothing to protect. There is now: it is closed.
    if (this.pendingRestore !== null) this.clearPendingRestore();
    this.setPhase('ready');
    if (options.keepWindow !== true) this.deps.ui.loadUrl(this.appUrl);
    void pruneOutbox(this.deps.paths.outbox, () => this.deps.now().getTime())
      .then((count) => {
        if (count > 0) this.log(`outbox: ${String(count)} old files deleted`);
      })
      .catch(() => undefined);
    // The backups found outside the ledger are looked at after the daily one, so the two never read the same file.
    void this.maybeDailyBackup().then(() => this.adoptUnledgered());
    if (options.keepWindow !== true) {
      // Just after the setup the person is looking at the key; later starts remind them if it is not confirmed.
      if (this.recoveryPending) {
        this.deps.ui.notify(TEXT.recoveryKey.reminderTitle, TEXT.recoveryKey.reminder);
      }
      this.maybeRemindCopy();
      this.maybeWarnAboutCloud();
    }
    clearInterval(this.dailyTimer);
    // Every minute: a failed backup is tried again after 5 minutes, then 10, 20, 40 and every hour, and this
    // is what notices that the time has come (or that a new day has begun).
    this.dailyTimer = setInterval(() => {
      void this.maybeDailyBackup();
      this.maybeRemindCopy();
    }, MINUTE_MS);
    this.dailyTimer.unref();
    clearInterval(this.databaseTimer);
    this.databaseMisses = 0;
    this.databaseTimer = setInterval(() => {
      void this.checkDatabase();
    }, DATABASE_CHECK_MS);
    this.databaseTimer.unref();
  }

  /** True when the install has its organization but the owner has not confirmed the recovery key. */
  get recoveryPending(): boolean {
    return this.loaded !== null && this.loaded.provisioned && !this.loaded.recoveryAcknowledged;
  }

  /** Reminds the person, every 30 days, to copy the backups off this PC: a copy on the same disk is lost with it. */
  private maybeRemindCopy(): void {
    if (this.currentPhase !== 'ready') return;
    const now = this.deps.now();
    const last = this.config.settings.lastCopyReminder;
    const due = last === null || now.getTime() - Date.parse(last) >= COPY_REMINDER_MS;
    if (!due) return;
    // The first run of the counter (an old configuration) only starts it.
    if (last !== null) this.deps.ui.notify(TEXT.backup.copyReminderTitle, TEXT.backup.copyReminder);
    try {
      this.config = this.deps.store.update((config) => {
        config.settings.lastCopyReminder = now.toISOString();
      });
    } catch (error) {
      this.log(
        `could not write the reminder down: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
      // `pg_dump` runs as the superuser, and that is a choice with a reason: every table has FORCE ROW LEVEL
      // SECURITY, which applies to its owner too, so `app_owner` (and every role without BYPASSRLS) would dump
      // only the rows its policies let it see, and a backup that silently leaves rows out is worse than none. It
      // is safe because what it reads is the LIVE database, which only the application has written: a restored
      // database passes `restore-audit.ts` before it becomes the live one, and nothing else of the superuser runs
      // inside a database a backup could have written (`postgres.test.ts` checks that).
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
      // `pg_restore --list` over the dump, to prove the program that will restore it can read it.
      listDump: (source: Readable) =>
        this.deps.pgTools.restore(
          this.deps.resources.pgRestore,
          ['--list'],
          osEnvironment(),
          source,
        ),
      dataBytes: async () =>
        (await directoryBytes(this.deps.paths.pgdata)) +
        (await directoryBytes(this.deps.paths.files)),
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
    /** The work reports its own failures, so a process that died meanwhile is not announced again. */
    reportsItself = false,
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
      if (kind === 'backup' && !reportsItself) this.reportFailureThatWaited();
    }
  }

  /** Resolves when no backup or restore is running. */
  async whenIdle(): Promise<void> {
    await this.inFlight;
  }

  /** A process that failed for good while a backup was running is announced once the backup is over. */
  private reportFailureThatWaited(): void {
    if (this.reportedFailure || this.currentPhase !== 'ready') return;
    if (this.api?.currentState !== 'failed' && this.worker?.currentState !== 'failed') return;
    this.reportedFailure = true;
    void this.runtimeFailureDialog();
  }

  /** The tray's "Hacer copia de seguridad". Returns the path of the backup, or `null` when it failed or could not start. */
  async backupNow(): Promise<string | null> {
    if (this.currentPhase !== 'ready') {
      await this.deps.ui.message('info', TEXT.backup.failed, TEXT.backup.notReady);
      return null;
    }
    if (this.restoreJournalPending()) {
      await this.deps.ui.message('error', TEXT.backup.failed, TEXT.restore.journalPending);
      return null;
    }
    const outcome = await this.exclusive(async () => {
      try {
        const result = await createBackup(this.backupDeps(), 'manual');
        this.recordGoodBackup();
        await this.pruneQuietly();
        return { path: result.path };
      } catch (error) {
        this.log(`backup failed: ${this.describeBackupFailure(error)}`);
        return { error };
      }
    });
    if (outcome === 'busy') {
      await this.deps.ui.message('info', TEXT.busy.title, TEXT.busy.body);
      return null;
    }
    if ('error' in outcome) {
      await this.deps.ui.message(
        'error',
        TEXT.backup.failed,
        this.backupFailureMessage(outcome.error),
      );
      return null;
    }
    this.log(`backup created: ${outcome.path}`);
    await this.deps.ui.message('info', TEXT.backup.done, TEXT.backup.doneBody(outcome.path));
    return outcome.path;
  }

  private describeBackupFailure(error: unknown): string {
    if (error instanceof BackupError) return `${error.message}: ${error.detail}`;
    if (error instanceof DiskFullError) {
      return `the disk is full (needed ${String(error.needed)}, free ${String(error.free)})`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  /** What the person is told when a backup could not be made: a full disk gets its own words. */
  private backupFailureMessage(error: unknown): string {
    if (!isDiskFull(error)) return TEXT.backup.failedBody;
    if (error instanceof DiskFullError && error.needed > 0) {
      const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
      return `${TEXT.backup.diskFull}\n\n${TEXT.backup.diskNeeds(gb(error.needed), gb(error.free))}`;
    }
    return TEXT.backup.diskFull;
  }

  /** The time of the last backup that passed its check, for the tray and "Acerca de". */
  private recordGoodBackup(): void {
    try {
      this.config = this.deps.store.update((config) => {
        config.settings.lastGoodBackup = this.deps.now().toISOString();
      });
      this.changed();
    } catch (error) {
      this.log(`could not write the time of the backup down: ${String(error)}`);
    }
  }

  /** "Última copia: 24/10/2026 10:00", or that there is none yet. */
  get lastBackupText(): string {
    const last = this.loaded?.settings.lastGoodBackup ?? null;
    return last === null
      ? TEXT.backup.none
      : TEXT.backup.last(new Date(last).toLocaleString('es-AR'));
  }

  /** Once: the backups are in a folder a cloud service syncs. They are encrypted, so this is advice, not a refusal. */
  private maybeWarnAboutCloud(): void {
    if (this.config.settings.cloudNoticeShown) return;
    if (!isCloudSynced(this.deps.paths.backups, this.deps.env ?? {})) return;
    this.config = this.deps.store.update((config) => {
      config.settings.cloudNoticeShown = true;
    });
    void this.deps.ui.message('info', TEXT.backup.cloudTitle, TEXT.backup.cloud);
  }

  /** Pruning is housekeeping: its failure never turns a backup that exists into a failed one. */
  /**
   * Backups in the folder that the ledger does not know (it was lost, or could not be written that day) are opened
   * again and entered if they pass, so that they count as copies and the owner is not told there is none.
   */
  private async adoptUnledgered(): Promise<void> {
    try {
      if (this.currentPhase !== 'ready') return;
      // Nothing to look at is the usual case, and it must not hold the backups up even for a moment.
      if ((await unledgeredBackups(this.deps.paths.backups)).length === 0) return;
      // One file at a time, each as an operation of its own: a backup or a restore that a person asks for in
      // between is not kept waiting for the rest, and the old copies give way to it (the check is repeated at the
      // next start).
      let adopted = 0;
      for (let looked = 0; looked < 5; looked += 1) {
        const result = await this.exclusive(() =>
          adoptUnledgeredBackups(this.backupDeps(), { max: 1 }),
        );
        if (result === 'busy') break;
        adopted += result.adopted.length;
        if (result.adopted.length + result.rejected.length + result.skipped.length === 0) break;
      }
      if (adopted > 0) {
        this.log(`${String(adopted)} backups found outside the ledger were checked and entered`);
      }
    } catch (error) {
      this.log(
        `looking for backups outside the ledger failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async pruneQuietly(): Promise<string[]> {
    try {
      const pruned = await pruneBackups(this.deps.paths.backups);
      if (pruned.length > 0) this.log(`${String(pruned.length)} old backups deleted`);
      return pruned;
    } catch (error) {
      this.log(
        `pruning old backups failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * The first time Consulvia is open on a day, and again after a failure (5 minutes later, then 10, 20, 40 and
   * every hour), until one backup of the day exists.
   */
  async maybeDailyBackup(): Promise<void> {
    if (this.currentPhase !== 'ready' || this.busy || this.restoreJournalPending()) return;
    const today = localDay(this.deps.now());
    if (this.config.settings.lastDailyBackup === today) return;
    if (this.deps.now().getTime() < this.nextDailyAttempt) return;
    await this.exclusive(async () => {
      let created;
      try {
        created = await createBackup(this.backupDeps(), 'daily');
      } catch (error) {
        this.log(`daily backup failed: ${this.describeBackupFailure(error)}`);
        this.dailyFailures += 1;
        const wait = Math.min(5 * MINUTE_MS * 2 ** (this.dailyFailures - 1), HOUR_MS);
        this.nextDailyAttempt = this.deps.now().getTime() + wait;
        if (this.lastDailyFailure !== today) {
          this.lastDailyFailure = today;
          this.deps.ui.notify(
            TEXT.backup.failed,
            isDiskFull(error) ? this.backupFailureMessage(error) : TEXT.backup.dailyFailed,
          );
        }
        return;
      }
      // The backup exists and was verified. Nothing after this point can make it a failed one.
      this.log(`daily backup created: ${created.path}`);
      this.dailyFailures = 0;
      this.nextDailyAttempt = 0;
      try {
        this.config = this.deps.store.update((config) => {
          config.settings.lastDailyBackup = today;
          config.settings.lastGoodBackup = this.deps.now().toISOString();
        });
        this.changed();
      } catch (error) {
        this.log(`could not write the day of the backup down: ${String(error)}`);
      }
      await this.pruneQuietly();
    });
  }

  // ---- restore ----------------------------------------------------------------------------------

  private restoreDeps() {
    return {
      paths: this.deps.paths,
      backupKey: () => Buffer.from(this.config.secrets.backupKeyBase64, 'base64'),
      // As a throwaway role made for this restore, never as `app_owner` or the superuser: what a backup contains
      // runs with the power of a role that owns its scratch database and nothing else (see `createRestoreScratch`).
      // `--no-privileges` because the grants of the objects are not taken from the dump but from the live database
      // (`trustedGrants`): a GRANT is the one statement of a dump that is meant to reach other roles.
      restoreDump: (source: Readable, scratch: ScratchHandle) =>
        this.deps.pgTools.restore(
          this.deps.resources.pgRestore,
          [
            '--host=127.0.0.1',
            `--port=${String(this.requireDatabasePort())}`,
            `--username=${scratch.user}`,
            `--dbname=${SCRATCH_DATABASE}`,
            '--no-owner',
            '--no-privileges',
            '--single-transaction',
            '--exit-on-error',
            '--no-password',
          ],
          { ...osEnvironment(), PGPASSWORD: scratch.password },
          source,
        ),
      scratch: {
        create: () => this.cluster.createRestoreScratch(SCRATCH_DATABASE),
        // The handle is the `RestoreScratch` that `create` returned: the restore only needs its role and password.
        inspect: (scratch: ScratchHandle) =>
          this.cluster.inspectRestoreScratch(scratch as RestoreScratch),
        seal: (scratch: ScratchHandle) =>
          this.cluster.sealRestoreScratch(scratch as RestoreScratch),
        swapIn: () => this.cluster.swapInDatabase(SCRATCH_DATABASE),
      },
      reconcile: () => reconcileInterruptedRestore({ ...this.reconcileDeps(), sweep: false }),
      audit: {
        snapshot: () => this.cluster.clusterFacts(DATABASE_NAME),
        check: async (snapshot: unknown) =>
          auditProblems(
            snapshot as ClusterFacts,
            await this.cluster.clusterFacts(SCRATCH_DATABASE),
            await this.cluster.scratchFacts(SCRATCH_DATABASE),
          ),
        revert: async (snapshot: unknown) => {
          const now = await this.cluster.clusterFacts(null);
          await this.cluster.executeStatements(
            revertStatements(snapshot as ClusterFacts, now, this.config.secrets.appOwnerPassword),
          );
        },
      },
      migrationCount: migrationCountOf(this.deps.resources),
      dataBytes: async () =>
        (await directoryBytes(this.deps.paths.pgdata)) +
        (await directoryBytes(this.deps.paths.files)),
      stopServices: () => this.stopServices(),
      startServices: async () => {
        await this.migrateDatabase();
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
          // A backup is made only of an install that has its organization.
          config.provisioned = true;
        });
      },
      now: this.deps.now,
      log: (message: string) => {
        this.log(message);
      },
    };
  }

  private restoreMessage(error: unknown): string {
    if (isDiskFull(error)) return TEXT.restore.diskFull;
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
        case 'restore_incomplete':
          return TEXT.restore.incomplete;
        case 'undo_incomplete':
          return TEXT.restore.undoIncomplete;
        case 'unsafe_backup':
          return TEXT.restore.unsafe;
        case 'services_not_started':
          return TEXT.restore.servicesFailed;
        default:
          return TEXT.restore.generic;
      }
    }
    return TEXT.restore.generic;
  }

  /**
   * The tray's "Restaurar copia…": choose the file, confirm, and then prove who is asking. On an install that is
   * in use EVERY restore needs the recovery key of THIS install (checked against its stored hash, five tries),
   * and a backup from another install needs that one's key too: without it, whoever sits at the tray could restore
   * a backup of their own making, adopt its keys and its owner, and take the clinic over. Only a new install that
   * is still waiting for its setup (or the one "Empezar de nuevo" makes) has nothing to protect and skips it.
   * The tests of the installer pass the file themselves (`--restore=<file>`), skip the question and read the
   * address of the keys page from the log, like the other pages.
   */
  async restoreFlow(file?: string): Promise<boolean> {
    if (this.restoreJournalPending()) {
      await this.deps.ui.message('error', TEXT.restore.failed, TEXT.restore.journalPending);
      return false;
    }
    if (this.busy) {
      await this.deps.ui.message('info', TEXT.busy.title, TEXT.busy.body);
      return false;
    }
    // On a new install that is still waiting for its setup the restore takes the place of the setup.
    if (this.currentPhase !== 'ready' && this.currentPhase !== 'setup') {
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
    const ownKeyId = keyIdOf(Buffer.from(this.config.secrets.backupKeyBase64, 'base64'));
    const foreign = info.header.keyId !== ownKeyId;
    if (file === undefined || !this.deps.testMode) {
      const confirmed = await this.deps.ui.confirm({
        title: TEXT.restore.confirmTitle,
        message: TEXT.restore.confirmMessage,
        detail: TEXT.restore.confirmDetail(
          new Date(info.header.createdAt).toLocaleString('es-AR'),
          TEXT.restore.kinds[info.header.kind],
          foreign,
          info.header.keyId.slice(0, 8),
        ),
        confirm: TEXT.restore.confirmButton,
        cancel: TEXT.restore.cancelButton,
      });
      if (!confirmed) return false;
    }
    if (this.currentPhase === 'ready') {
      this.askForRestoreKeys({ archive, needsCurrent: true, needsBackup: foreign });
      return false;
    }
    // A new install: nothing to lose, and only a backup of another install needs its key.
    const outcome = await this.runRestore(archive);
    if (outcome === 'busy') {
      await this.deps.ui.message('info', TEXT.busy.title, TEXT.busy.body);
      return false;
    }
    if (outcome.ok) return this.finishRestore();
    if (outcome.needsKey) {
      this.askForRestoreKeys({ archive, needsCurrent: false, needsBackup: true });
      return false;
    }
    await this.deps.ui.message('error', TEXT.restore.failed, this.restoreMessage(outcome.error));
    return false;
  }

  /** Opens the page that asks for the keys of a restore that is waiting. */
  private askForRestoreKeys(pending: {
    archive: string;
    needsCurrent: boolean;
    needsBackup: boolean;
  }): void {
    this.pendingRestore = pending;
    this.restoreAttempts = 0;
    const token = this.vault.issue(PURPOSE.key, 15 * 60_000);
    const url = `${this.appUrl}/__key?t=${token}`;
    this.deps.ui.openAuxWindow(url, TEXT.recoveryKey.windowTitle);
    // Like the setup and reset addresses: written down only for the tests of the installer.
    if (this.deps.testMode) this.log(`restore keys url: ${url}`);
  }

  /** Makes the safety backup (on an install in use) and restores. */
  /**
   * A restore that was cut off, or could not be undone, leaves `restore-journal.json` until the next start finishes it.
   * Until then the data may be half way between two states, and no copy of them (or restore over them) is made.
   */
  private restoreJournalPending(): boolean {
    return existsSync(journalFile(this.deps.paths));
  }

  /**
   * A restore that failed and left the program stopped (it could not undo itself, or could not start the services
   * again): the person is told with the dialog every failed start has, and its Retry starts again from the
   * beginning, which finishes what was left.
   */
  private afterBrokenRestore(error: RestoreError): void {
    clearInterval(this.dailyTimer);
    clearInterval(this.databaseTimer);
    this.setPhase('error');
    void this.fail(
      new ShellError(
        error.code === 'undo_incomplete'
          ? TEXT.restore.undoIncomplete
          : TEXT.restore.servicesFailed,
        `a restore left the program stopped: ${error.code}: ${error.detail}`,
      ),
    );
  }

  /** Forgets the restore that waits for its keys: its address stops working and its window closes. */
  private clearPendingRestore(): void {
    this.pendingRestore = null;
    this.vault.revoke(PURPOSE.key);
    this.deps.ui.closeAuxWindow();
  }

  /**
   * Whether a restore needs the recovery key of THIS install: always, except on an install that is still waiting for
   * its setup. Decided when the keys arrive, never when the page was opened.
   */
  private currentKeyRequired(): boolean {
    return !(this.currentPhase === 'setup' && !this.config.provisioned);
  }

  private async runRestore(
    archive: string,
    keys: { current?: string; backup?: string } = {},
  ): Promise<'busy' | { ok: true } | { ok: false; needsKey: boolean; error?: unknown }> {
    // The key of the install is checked here as well as by the page: whatever way a restore is reached, it does not
    // start on an install that is in use without it.
    if (
      this.currentKeyRequired() &&
      !verifyRecoveryKey(keys.current ?? '', this.config.secrets.recoveryKeyHash)
    ) {
      this.log('a restore was asked for without the recovery key of this install: refused');
      return {
        ok: false,
        needsKey: false,
        error: new RestoreError('restore_failed', 'the recovery key of this install was not given'),
      };
    }
    const recoveryKey = keys.backup;
    const outcome = await this.exclusive(async () => {
      this.deps.ui.showSplash(TEXT.splash.restoring);
      try {
        // A new install that is still waiting for its setup has nothing to lose.
        if (this.currentPhase === 'ready') {
          const safety = await createBackup(this.backupDeps(), 'safety');
          this.log(`safety backup before restoring: ${safety.path}`);
        }
        await restoreBackup(this.restoreDeps(), archive, {
          ...(recoveryKey === undefined ? {} : { recoveryKey }),
        });
        return { ok: true as const };
      } catch (error) {
        if (error instanceof RestoreError && error.code === 'recovery_key_required') {
          return { ok: false as const, needsKey: true };
        }
        this.log(
          `restore failed: ${error instanceof RestoreError ? `${error.code}: ${error.detail}` : String(error)}`,
        );
        return { ok: false as const, needsKey: false, error };
      }
    }, 'restore');
    if (
      outcome !== 'busy' &&
      !outcome.ok &&
      outcome.error instanceof RestoreError &&
      (outcome.error.code === 'undo_incomplete' || outcome.error.code === 'services_not_started')
    ) {
      this.afterBrokenRestore(outcome.error);
      return outcome;
    }
    this.deps.ui.loadUrl(this.appUrl);
    return outcome;
  }

  private async finishRestore(): Promise<true> {
    this.log('restore finished');
    this.endSetupAfterRestore();
    await this.deps.ui.message('info', TEXT.restore.done, TEXT.restore.doneBody);
    return true;
  }

  /** A restore on an install that was waiting for its setup: the organization came with the backup. */
  private endSetupAfterRestore(): void {
    if (this.currentPhase !== 'setup') return;
    this.vault.revoke(PURPOSE.setup);
    this.finishStart({ keepWindow: true });
  }

  // ---- the owner's password ---------------------------------------------------------------------

  async openResetPassword(): Promise<void> {
    if (this.currentPhase !== 'ready') {
      await this.deps.ui.message('info', TEXT.tray.resetPassword, TEXT.reset.notReady);
      return;
    }
    // The tray is open to whoever sits at the Windows session: ask before a page that can take over the
    // owner's account is offered at all (the page then asks for the recovery key).
    if (!this.deps.testMode) {
      const confirmed = await this.deps.ui.confirm({
        title: TEXT.reset.confirmTitle,
        message: TEXT.reset.confirmMessage,
        detail: TEXT.reset.confirmDetail,
        confirm: TEXT.reset.confirmButton,
        cancel: TEXT.reset.cancelButton,
      });
      if (!confirmed) return;
    }
    this.resetAttempts = 0;
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

  /** A wrong answer on a page about the recovery key: five of them and the address stops working. */
  private keyPageMiss(
    purpose: typeof PURPOSE.ack | typeof PURPOSE.check,
    field: string,
    message: string,
  ): { ok: false; errors?: Record<string, string>; message?: string } {
    this.keyPageAttempts += 1;
    this.log(`recovery key page: wrong answer (attempt ${String(this.keyPageAttempts)})`);
    if (this.keyPageAttempts >= MAX_RESET_ATTEMPTS) {
      this.vault.revoke(purpose);
      this.deps.ui.closeAuxWindow();
      return { ok: false, message: TEXT.recoveryKey.tooManyAttempts };
    }
    return { ok: false, errors: { [field]: message } };
  }

  private pageActions(): PageActions {
    return {
      isProvisioned: () => this.loaded?.provisioned ?? false,
      commonPasswords: () => this.commonPasswords(),
      setup: (values) => this.runSetup(values),
      resetPassword: async (input): Promise<ResetOutcome> => {
        // A backup reads the database and does not mind; a restore is replacing it.
        if (this.restoring) return { ok: false, message: TEXT.reset.generic };
        if (!verifyRecoveryKey(input.recoveryKey, this.config.secrets.recoveryKeyHash)) {
          this.resetAttempts += 1;
          this.log(`reset refused: wrong recovery key (attempt ${String(this.resetAttempts)})`);
          if (this.resetAttempts >= MAX_RESET_ATTEMPTS) {
            this.vault.revoke(PURPOSE.reset);
            this.deps.ui.closeAuxWindow();
            return { ok: false, message: TEXT.reset.tooManyAttempts };
          }
          return { ok: false, errors: { recoveryKey: TEXT.reset.wrongKey } };
        }
        const outcome = await (async () => {
          try {
            const context = this.runtimeContext(this.apiPort ?? 0);
            return await this.deps.commands.resetPassword(commandEnvironment(context), {
              newPassword: input.newPassword,
              clearSecondFactor: input.clearSecondFactor,
            });
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
        this.log(
          `the password of the owner was reset (owner notified: ${String(outcome.ownerNotified)})`,
        );
        // One reset per page: the address is good for nothing once it has done its job.
        this.vault.revoke(PURPOSE.reset);
        return { ok: true, email: outcome.email, secondFactorCleared: outcome.secondFactorCleared };
      },
      confirmRecoveryKey: (lastFour) => {
        if (this.pendingSetup) return this.completeSetup(this.pendingSetup, lastFour);
        if (this.pendingRegeneration) return Promise.resolve(this.confirmRegeneration(lastFour));
        const stored = this.pendingRecoveryKey;
        if (this.config.recoveryAcknowledged || stored === null) {
          return Promise.resolve({ ok: false, message: TEXT.recoveryKey.gone });
        }
        if (normalizeRecoveryKey(lastFour) !== normalizeRecoveryKey(stored).slice(-4)) {
          return Promise.resolve(
            this.keyPageMiss(PURPOSE.ack, 'recoveryKeyLast4', TEXT.recoveryKey.wrongLast4),
          );
        }
        this.acknowledgeRecoveryKey();
        this.vault.revoke(PURPOSE.ack);
        this.log('the recovery key was confirmed by the owner and is no longer kept');
        this.changed();
        return Promise.resolve({ ok: true });
      },
      checkRecoveryKey: (typed) => {
        if (!verifyRecoveryKey(typed, this.config.secrets.recoveryKeyHash)) {
          return Promise.resolve(
            this.keyPageMiss(PURPOSE.check, 'recoveryKey', TEXT.recoveryKey.wrong),
          );
        }
        // Typing the whole key right proves the owner has it, which is what the confirmation is for.
        if (!this.config.recoveryAcknowledged) this.acknowledgeRecoveryKey();
        this.vault.revoke(PURPOSE.check);
        return Promise.resolve({ ok: true });
      },
      browserSession: () => this.credentials.browser,
      regenerateRecoveryKey: (input) => this.regenerateRecoveryKey(input),
      restoreKeyNeeds: () => ({
        current: (this.pendingRestore?.needsCurrent ?? true) || this.currentKeyRequired(),
        backup: this.pendingRestore?.needsBackup ?? false,
      }),
      submitRecoveryKey: async (keys) => {
        const pending = this.pendingRestore;
        if (!pending) return { ok: false, message: TEXT.restore.generic };
        const miss = (errors: Record<string, string>) => {
          this.restoreAttempts += 1;
          this.log(`restore keys: wrong answer (attempt ${String(this.restoreAttempts)})`);
          if (this.restoreAttempts >= MAX_RESET_ATTEMPTS) {
            this.vault.revoke(PURPOSE.key);
            this.pendingRestore = null;
            this.deps.ui.closeAuxWindow();
            return { ok: false as const, message: TEXT.restore.tooManyAttempts };
          }
          return { ok: false as const, errors };
        };
        const needsCurrent = pending.needsCurrent || this.currentKeyRequired();
        if (needsCurrent) {
          if (keys.current.trim() === '') {
            return { ok: false, errors: { currentKey: TEXT.restore.currentKeyRequired } };
          }
          if (!verifyRecoveryKey(keys.current, this.config.secrets.recoveryKeyHash)) {
            return miss({ currentKey: TEXT.restore.wrongCurrentKey });
          }
        }
        if (pending.needsBackup && keys.backup.trim() === '') {
          return { ok: false, errors: { recoveryKey: TEXT.restore.backupKeyRequired } };
        }
        const outcome = await this.runRestore(pending.archive, {
          ...(needsCurrent ? { current: keys.current } : {}),
          ...(pending.needsBackup ? { backup: keys.backup } : {}),
        });
        if (outcome === 'busy') return { ok: false, message: TEXT.busy.body };
        if (outcome.ok) {
          this.pendingRestore = null;
          this.vault.revoke(PURPOSE.key);
          this.deps.ui.closeAuxWindow();
          // The notice waits for a click of the owner: the page that asked for the keys is not held up by it.
          void this.finishRestore();
          return { ok: true };
        }
        if (outcome.needsKey)
          return { ok: false, errors: { recoveryKey: TEXT.restore.backupKeyRequired } };
        if (outcome.error instanceof RestoreError && outcome.error.code === 'wrong_recovery_key') {
          return miss({ recoveryKey: TEXT.restore.wrongKey });
        }
        return { ok: false, message: this.restoreMessage(outcome.error) };
      },
    };
  }

  // ---- the tray ---------------------------------------------------------------------------------

  openApp(): void {
    this.deps.ui.showMainWindow();
  }

  openInBrowser(): void {
    if (this.currentPhase !== 'ready') return;
    // Not the plain address: the browser has no proof, and the address that gives it one works once.
    const token = this.vault.issue(PURPOSE.browser, 60_000);
    this.deps.ui.openExternal(`${this.appUrl}/__browser?t=${token}`);
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

  /**
   * The tray's item about the recovery key. Until the owner confirms having saved it, it opens the page that
   * shows it with the box that confirms it; after that the key is not kept, and the page only checks a typed one.
   */
  openRecoveryKey(): void {
    if (this.currentPhase !== 'ready') return;
    this.keyPageAttempts = 0;
    // The key is not shown here, ever: the owner types the one from their paper copy and the shell checks it.
    const token = this.vault.issue(PURPOSE.check, 15 * 60_000);
    this.deps.ui.openAuxWindow(
      `${this.appUrl}/__check?t=${token}`,
      TEXT.recoveryKey.checkWindowTitle,
    );
  }

  /** The owner has the key: from here nothing about it is kept, in memory or on disk, but its hash. */
  private acknowledgeRecoveryKey(): void {
    this.pendingRecoveryKey = null;
    this.config = this.deps.store.update((config) => {
      config.recoveryAcknowledged = true;
      config.secrets.recoveryKey = null;
    });
    this.log('the recovery key was confirmed by the owner and is not kept');
    this.changed();
  }

  /** The tray: a new recovery key for an install that never confirmed one. Gated by the owner, not by the Windows session. */
  openRegenerateRecoveryKey(): void {
    if (this.currentPhase !== 'ready' || !this.recoveryPending) return;
    this.regenerateAttempts = 0;
    this.pendingRegeneration = null;
    const token = this.vault.issue(PURPOSE.regenerate, 15 * 60_000);
    this.deps.ui.openAuxWindow(
      `${this.appUrl}/__regen?t=${token}`,
      TEXT.recoveryKey.regenerateWindowTitle,
    );
  }

  private async regenerateRecoveryKey(input: {
    email: string;
    password: string;
    code: string;
  }): Promise<RegenerateOutcome> {
    if (!this.recoveryPending) return { ok: false, message: TEXT.regenerate.notNeeded };
    if (this.apiPort === null || this.proxySecret === null || this.currentPhase !== 'ready') {
      return { ok: false, message: TEXT.regenerate.unavailable };
    }
    if (this.busy) return { ok: false, message: TEXT.regenerate.busy };
    // The password and the second factor are checked by the API itself: the same lockout, the same trail.
    const checked = await this.deps.verifyOwner({
      apiPort: this.apiPort,
      proxySecret: this.proxySecret,
      publicOrigin: this.appUrl,
      email: input.email,
      password: input.password,
      code: input.code,
    });
    if (!checked.ok) {
      if (checked.reason === 'unavailable')
        return { ok: false, message: TEXT.regenerate.unavailable };
      if (checked.reason === 'needs_code') {
        return { ok: false, errors: { code: TEXT.regenerate.codeRequired } };
      }
      this.regenerateAttempts += 1;
      this.log(
        `a new recovery key was refused: the owner was not proven (attempt ${String(this.regenerateAttempts)})`,
      );
      if (this.regenerateAttempts >= MAX_RESET_ATTEMPTS) {
        this.vault.revoke(PURPOSE.regenerate);
        this.deps.ui.closeAuxWindow();
        return { ok: false, message: TEXT.recoveryKey.tooManyAttempts };
      }
      return { ok: false, errors: { password: TEXT.regenerate.refused } };
    }
    const fresh = newRecoveryKey(this.config.secrets.backupKeyBase64);
    this.pendingRegeneration = fresh;
    this.keyPageAttempts = 0;
    this.log(
      'a new recovery key was made after the owner proved who they are; it counts once it is confirmed',
    );
    return {
      ok: true,
      recoveryKey: fresh.recoveryKey,
      ackToken: this.vault.issue(PURPOSE.ack, 15 * 60_000),
    };
  }

  /** The owner typed the end of the new key: from here it is the key of the install, and the old one is not. */
  private confirmRegeneration(lastFour: string): ConfirmOutcome {
    const fresh = this.pendingRegeneration;
    if (fresh === null) return { ok: false, message: TEXT.recoveryKey.gone };
    if (normalizeRecoveryKey(lastFour) !== normalizeRecoveryKey(fresh.recoveryKey).slice(-4)) {
      return this.keyPageMiss(PURPOSE.ack, 'recoveryKeyLast4', TEXT.recoveryKey.wrongLast4);
    }
    this.pendingRegeneration = null;
    this.pendingRecoveryKey = null;
    this.config = this.deps.store.update((config) => {
      config.secrets.backupKeyWrap = fresh.backupKeyWrap;
      config.secrets.recoveryKeyHash = fresh.recoveryKeyHash;
      config.secrets.recoveryKey = null;
      config.recoveryAcknowledged = true;
    });
    this.vault.revoke(PURPOSE.ack);
    this.vault.revoke(PURPOSE.regenerate);
    this.log('a new recovery key was confirmed by the owner; the old one no longer works');
    this.changed();
    return { ok: true };
  }

  async about(): Promise<void> {
    await this.deps.ui.message(
      'info',
      TEXT.about.title,
      TEXT.appName,
      TEXT.about.detail(
        this.deps.version,
        this.deps.paths.root,
        this.deps.paths.backups,
        this.lastBackupText,
      ),
    );
  }

  markTrayHintShown(): void {
    if (!this.loaded) return;
    this.config = this.deps.store.update((config) => {
      config.settings.trayHintShown = true;
    });
  }

  // ---- quit -------------------------------------------------------------------------------------

  /**
   * Stops what runs before a retry or a start over. A failure here is logged and does not stop the dialog that
   * follows: the person asked for a way out, and a service that will not stop is a reason for one, not for
   * leaving the splash with nothing to click.
   */
  private async stopQuietly(): Promise<void> {
    try {
      await this.stopEverything();
    } catch (error) {
      this.log(
        `could not stop everything before starting again: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

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
      clearInterval(this.databaseTimer);
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
