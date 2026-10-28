import { spawn } from 'node:child_process';
import { join } from 'node:path';

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
} from 'electron';
import pg from 'pg';

import { createApiCommands } from './api-commands.js';
import { parseArgs, type LaunchRequest } from './cli-args.js';
import { ConfigStore, type Cipher } from './config-store.js';
import { Controller, type ShellUi } from './controller.js';
import { probeApiHealth } from './health-probe.js';
import { decideNavigation, decideWindowOpen } from './navigation-policy.js';
import { verifyOwner } from './owner-check.js';
import { resolveDataPaths } from './paths.js';
import { findFreePort } from './ports.js';
import { PostgresCluster } from './postgres.js';
import { redact } from './redact.js';
import { resolveResources } from './resources.js';
import { createRotatingLog } from './rotating-log.js';
import { spawnRunner } from './runner.js';
import { splashUrl } from './splash.js';
import { spawnPgTools } from './streams.js';
import { TEXT } from './strings.js';
import type { ChildLike } from './supervisor.js';
import { headersWithProof } from './window-proof.js';
import { AUX_WINDOW, fitToWorkArea, MAIN_WINDOW } from './window-size.js';

/**
 * The Electron entry: windows, tray, dialogs and the single-instance rules. Everything that decides
 * something is in `Controller`; this file only draws it and passes the user's choices on.
 */

const testMode = process.env['CONSULVIA_TEST_MODE'] === '1';
const startup = parseArgs(process.argv.slice(1));

// The Chromium profile lives with the data, so a test install does not share a lock or cookies with a real one.
const paths = resolveDataPaths({
  env: process.env,
  // Electron has no path for the local folder: Windows names it in the environment.
  localAppData: process.env['LOCALAPPDATA'] ?? join(app.getPath('home'), 'AppData', 'Local'),
  documents: app.getPath('documents'),
});
app.setName('Consulvia');
app.setPath('userData', paths.electronProfile);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock || startup.request.kind === 'quit') {
  // Another copy runs (it is told what this launch asked for), or this launch only wanted to stop one.
  app.quit();
} else {
  void run();
}

async function run(): Promise<void> {
  let mainWindow: BrowserWindow | null = null;
  let auxWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;

  const resourcesRoot = app.isPackaged
    ? process.resourcesPath
    : (process.env['CONSULVIA_RESOURCES'] ?? join(app.getAppPath(), 'stage'));
  const resources = resolveResources(resourcesRoot);

  // The tails of the standard error of the other programs end up here: nothing that names a person.
  const shellLog = createRotatingLog(join(paths.logs, 'shell.log'), { transform: redact });
  const logs = {
    shell: shellLog,
    api: createRotatingLog(join(paths.logs, 'api.log')),
    worker: createRotatingLog(join(paths.logs, 'worker.log')),
  };
  process.on('uncaughtException', (error) => {
    shellLog.write(
      `${new Date().toISOString()} uncaught exception: ${error.stack ?? error.message}\n`,
    );
  });

  await app.whenReady();
  Menu.setApplicationMenu(null);

  const secureWindow = (options: Electron.BrowserWindowConstructorOptions) =>
    new BrowserWindow({
      icon: resources.windowIcon,
      autoHideMenuBar: true,
      backgroundColor: '#f3f6f6',
      ...options,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: process.env['CONSULVIA_DEVTOOLS'] === '1',
        spellcheck: false,
      },
    });

  let knownPort = 0;
  const appOrigin = () => `http://127.0.0.1:${String(knownPort)}`;

  /**
   * Keeps every page of the program on the app: other web addresses open in the browser of the PC, nothing
   * else leaves, and no page opens a window of its own. It is attached to EVERY web contents (windows, frames
   * and anything a page creates), not to the windows the shell opens itself.
   */
  app.on('web-contents-created', (_event, contents) => {
    const navigate = (event: { preventDefault: () => void }, url: string) => {
      const decision = decideNavigation(url, appOrigin());
      if (decision.action === 'allow') return;
      event.preventDefault();
      if (decision.action === 'external') void shell.openExternal(decision.url);
    };
    contents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen(url, appOrigin());
      if (decision.openExternally !== undefined) void shell.openExternal(decision.openExternally);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (details) => {
      navigate(details, details.url);
    });
    contents.on('will-redirect', (details) => {
      navigate(details, details.url);
    });
    contents.on('will-frame-navigate', (details) => {
      navigate(details, details.url);
    });
  });

  function createMainWindow(): BrowserWindow {
    const window = secureWindow({
      // A laptop screen is smaller than the preferred size: open inside the free area of the display.
      ...fitToWorkArea(MAIN_WINDOW, screen.getPrimaryDisplay().workAreaSize),
      show: false,
      title: TEXT.appName,
    });
    window.once('ready-to-show', () => {
      if (!startup.hidden || testMode) window.show();
    });
    window.on('close', (event) => {
      if (quitting) return;
      // Closing the window leaves Consulvia running in the tray: the agendas and reminders go on.
      event.preventDefault();
      window.hide();
      if (!controller.trayHintShown) {
        controller.markTrayHintShown();
        new Notification({ title: TEXT.hint.title, body: TEXT.hint.body }).show();
      }
    });
    // Windows is ending the session (shutdown or log off): stop cleanly instead of being cut off.
    window.on('session-end', () => {
      void gracefulQuit();
    });
    window.on('closed', () => {
      mainWindow = null;
    });
    return window;
  }

  const ui: ShellUi = {
    showSplash(message, busy = true) {
      mainWindow ??= createMainWindow();
      void mainWindow.loadURL(splashUrl(message, busy));
    },
    loadUrl(url) {
      mainWindow ??= createMainWindow();
      knownPort = Number(new URL(url).port);
      void mainWindow.loadURL(url);
    },
    showMainWindow() {
      mainWindow ??= createMainWindow();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
    openAuxWindow(url, title) {
      auxWindow?.close();
      const parent = mainWindow ?? undefined;
      auxWindow = secureWindow({
        ...fitToWorkArea(AUX_WINDOW, screen.getPrimaryDisplay().workAreaSize),
        title,
        ...(parent ? { parent } : {}),
        show: true,
      });
      auxWindow.on('closed', () => {
        auxWindow = null;
      });
      void auxWindow.loadURL(url);
    },
    closeAuxWindow() {
      auxWindow?.close();
    },
    async confirm({ title, message, detail, confirm, cancel }) {
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title,
        message,
        detail,
        buttons: [confirm, cancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const result = mainWindow?.isVisible()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    },
    async message(kind, title, message, detail) {
      const options: Electron.MessageBoxOptions = {
        type: kind,
        title,
        message,
        buttons: [TEXT.about.ok],
        noLink: true,
        ...(detail === undefined ? {} : { detail }),
      };
      if (mainWindow?.isVisible()) await dialog.showMessageBox(mainWindow, options);
      else await dialog.showMessageBox(options);
    },
    async choose({ kind, title, message, detail, buttons }) {
      const options: Electron.MessageBoxOptions = {
        type: kind,
        title,
        message,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true,
        ...(detail === undefined ? {} : { detail }),
      };
      const result = mainWindow?.isVisible()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      return result.response;
    },
    notify(title, body) {
      new Notification({ title, body }).show();
    },
    async pickFile({ title, defaultPath, filterName }) {
      const options: Electron.OpenDialogOptions = {
        title,
        defaultPath,
        properties: ['openFile'],
        filters: [{ name: filterName, extensions: ['cvb'] }],
      };
      const result = mainWindow?.isVisible()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async openPath(path) {
      await shell.openPath(path);
    },
    openExternal(url) {
      void shell.openExternal(url);
    },
    setAutoStart(enabled) {
      // Only the installed program registers itself with Windows; a development run must not.
      if (app.isPackaged && !testMode) {
        app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
      }
    },
    copyToClipboard(text) {
      void clipboard.writeText(text);
    },
  };

  const cipher: Cipher = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  };

  const runner = spawnRunner;
  const controller = new Controller({
    paths,
    resources,
    store: new ConfigStore(paths.configFile, cipher),
    pgTools: spawnPgTools,
    commands: createApiCommands({
      runner,
      nodeExe: process.execPath,
      mainJs: resources.mainJs,
      cwd: resources.apiDir,
    }),
    ui,
    version: app.getVersion(),
    spawnLongRunning: (role, env): ChildLike =>
      spawn(process.execPath, [resources.mainJs, role], {
        cwd: resources.apiDir,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      }),
    probeHealth: (port, secret) => probeApiHealth(port, secret),
    verifyOwner: (options) => verifyOwner(options),
    createCluster: (secrets) =>
      new PostgresCluster({
        binDir: resources.pgBinDir,
        pgdata: paths.pgdata,
        logFile: join(paths.logs, 'postgres.log'),
        superuserPassword: secrets.pgSuperuserPassword,
        ownerPassword: secrets.appOwnerPassword,
        runner,
        connect: (target) => new pg.Client(target),
        freePort: () => findFreePort(),
        isPostgresProcess: async (pid) => {
          const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
          const result = await runner(join(systemRoot, 'System32', 'tasklist.exe'), [
            '/FI',
            `PID eq ${String(pid)}`,
            '/FO',
            'CSV',
            '/NH',
          ]);
          return result.stdout.toLowerCase().includes('"postgres.exe"');
        },
        scratchDir: join(paths.root, 'tmp'),
        log: (message) => {
          shellLog.write(`${new Date().toISOString()} postgres: ${message}\n`);
        },
      }),
    logs,
    testMode,
    env: process.env,
    now: () => new Date(),
    requestQuit: () => {
      void gracefulQuit();
    },
  });

  async function gracefulQuit(): Promise<void> {
    if (quitting) return;
    quitting = true;
    tray?.destroy();
    tray = null;
    await controller.quit();
    app.exit(0);
  }

  async function handleRequest(request: LaunchRequest): Promise<void> {
    switch (request.kind) {
      case 'quit':
        await gracefulQuit();
        return;
      case 'backup':
        await controller.backupNow();
        return;
      case 'restore':
        await controller.restoreFlow(request.file);
        return;
      case 'reset-password':
        void controller.openResetPassword();
        return;
      case 'show':
        controller.openApp();
    }
  }

  app.on('second-instance', (_event, argv) => {
    void handleRequest(parseArgs(argv.slice(1)).request);
  });
  app.on('window-all-closed', () => {
    // Consulvia stays in the tray when its window closes.
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void gracefulQuit();
  });

  // Every request of a window to the local server carries the proof of this run, added here below the page: the
  // server refuses the API to anything that does not have it, so another program of the PC cannot use the port.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      requestHeaders: headersWithProof(
        details.requestHeaders,
        details.url,
        knownPort,
        controller.windowProof,
      ),
    });
  });

  // A page is never granted a permission it did not need: the web app asks for none but the clipboard.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission) => permission === 'clipboard-sanitized-write',
  );

  tray = new Tray(nativeImage.createFromPath(resources.trayIcon));
  tray.setToolTip(TEXT.tray.tooltip);
  const drawMenu = () => {
    if (!tray) return;
    const ready = controller.phase === 'ready';
    tray.setToolTip(
      controller.recoveryPending ? TEXT.tray.tooltipRecoveryPending : TEXT.tray.tooltip,
    );
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: TEXT.tray.open,
          click: () => {
            controller.openApp();
          },
        },
        {
          label: TEXT.tray.openInBrowser,
          enabled: ready,
          click: () => {
            controller.openInBrowser();
          },
        },
        { type: 'separator' },
        { label: TEXT.tray.outbox, click: () => void controller.openOutbox() },
        { label: controller.lastBackupText, enabled: false },
        { label: TEXT.tray.backup, enabled: ready, click: () => void controller.backupNow() },
        {
          label: TEXT.tray.restore,
          // On a new install the restore takes the place of the setup form.
          enabled: ready || controller.phase === 'setup',
          click: () => void controller.restoreFlow(),
        },
        {
          label: TEXT.tray.resetPassword,
          enabled: ready,
          click: () => {
            void controller.openResetPassword();
          },
        },
        {
          label: controller.recoveryPending
            ? TEXT.tray.confirmRecoveryKey
            : TEXT.tray.checkRecoveryKey,
          enabled: ready,
          click: () => {
            controller.openRecoveryKey();
          },
        },
        ...(controller.recoveryPending
          ? [
              {
                label: TEXT.tray.regenerateRecoveryKey,
                enabled: ready,
                click: () => {
                  controller.openRegenerateRecoveryKey();
                },
              },
            ]
          : []),
        { type: 'separator' },
        { label: TEXT.tray.logs, click: () => void controller.openLogs() },
        {
          label: TEXT.tray.autoStart,
          type: 'checkbox',
          checked: controller.autoStart,
          click: () => {
            controller.toggleAutoStart();
          },
        },
        { label: TEXT.tray.about, click: () => void controller.about() },
        { type: 'separator' },
        { label: TEXT.tray.quit, click: () => void gracefulQuit() },
      ]),
    );
  };
  controller.onChange(drawMenu);
  tray.on('click', () => {
    controller.openApp();
  });
  drawMenu();

  await controller.start();
  controller.syncAutoStart();
  drawMenu();
  if (startup.request.kind !== 'show') await handleRequest(startup.request);
}
