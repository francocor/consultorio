import { spawn } from 'node:child_process';
import { get } from 'node:http';
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
  session,
  shell,
  Tray,
} from 'electron';
import pg from 'pg';

import { createApiCommands } from './api-commands.js';
import { parseArgs, type LaunchRequest } from './cli-args.js';
import { ConfigStore, type Cipher } from './config-store.js';
import { Controller, type ShellUi } from './controller.js';
import { resolveDataPaths } from './paths.js';
import { findFreePort } from './ports.js';
import { PostgresCluster } from './postgres.js';
import { resolveResources } from './resources.js';
import { createRotatingLog } from './rotating-log.js';
import { spawnRunner } from './runner.js';
import { splashUrl } from './splash.js';
import { TEXT } from './strings.js';
import type { ChildLike } from './supervisor.js';

/**
 * The Electron entry: windows, tray, dialogs and the single-instance rules. Everything that decides
 * something is in `Controller`; this file only draws it and passes the user's choices on.
 */

const testMode = process.env['CONSULVIA_TEST_MODE'] === '1';
const startup = parseArgs(process.argv.slice(1));

// The Chromium profile lives with the data, so a test install does not share a lock or cookies with a real one.
const paths = resolveDataPaths({
  env: process.env,
  appData: app.getPath('appData'),
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

  const shellLog = createRotatingLog(join(paths.logs, 'shell.log'));
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

  /** Keeps a window on the app: other addresses open in the browser, and no window opens by itself. */
  function guard(window: BrowserWindow): void {
    const origin = () => `http://localhost:${String(controllerPort())}`;
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(origin())) return { action: 'allow' };
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('data:') || url.startsWith(origin())) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });
  }

  let knownPort = 0;
  const controllerPort = () => knownPort;

  function createMainWindow(): BrowserWindow {
    const window = secureWindow({
      width: 1360,
      height: 860,
      minWidth: 800,
      minHeight: 560,
      show: false,
      title: TEXT.appName,
    });
    guard(window);
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
        width: 560,
        height: 720,
        title,
        ...(parent ? { parent } : {}),
        show: true,
      });
      guard(auxWindow);
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
        filters: [{ name: filterName, extensions: ['zip'] }],
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
    runner,
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
    probeHealth: (port) =>
      new Promise((resolve) => {
        const request = get(
          { host: '127.0.0.1', port, path: '/health', timeout: 2_000 },
          (response) => {
            response.resume();
            resolve(response.statusCode === 200);
          },
        );
        request.on('timeout', () => {
          request.destroy();
          resolve(false);
        });
        request.on('error', () => {
          resolve(false);
        });
      }),
    createCluster: (secrets) =>
      new PostgresCluster({
        binDir: resources.pgBinDir,
        pgdata: paths.pgdata,
        logFile: join(paths.logs, 'postgres.log'),
        superuserPassword: secrets.pgSuperuserPassword,
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
        controller.openResetPassword();
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
        { label: TEXT.tray.backup, enabled: ready, click: () => void controller.backupNow() },
        { label: TEXT.tray.restore, enabled: ready, click: () => void controller.restoreFlow() },
        {
          label: TEXT.tray.resetPassword,
          enabled: ready,
          click: () => {
            controller.openResetPassword();
          },
        },
        { label: TEXT.tray.recoveryKey, click: () => void controller.showRecoveryKey() },
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
