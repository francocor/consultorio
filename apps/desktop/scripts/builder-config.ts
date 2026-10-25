import type { Configuration } from 'electron-builder';

export interface BuilderPaths {
  /** `stage/`: the API, the web app, PostgreSQL, the tools, the SQL and the icons. */
  stageDir: string;
  /** Where `icon.ico` is. */
  buildDir: string;
  /** Where the installer is written. */
  outputDir: string;
}

/**
 * The installer: NSIS, one click, for the current Windows user only (no administrator prompt), with the
 * shortcuts "Consulvia" on the desktop and in the Start menu. The program files go to
 * `%LOCALAPPDATA%\Programs\Consulvia`; the data of the clinic is in `%APPDATA%\Consulvia` and is never
 * touched by an update or by the uninstaller.
 *
 * Everything the shell runs besides itself (the API and its modules, the web app, PostgreSQL, the backup
 * tools) goes to `resources/` as plain files, outside the `app.asar` archive: the API is a separate
 * program run with `ELECTRON_RUN_AS_NODE`, PostgreSQL is a set of executables, and a native module
 * (`@node-rs/argon2`, `sharp`) cannot be loaded from inside an archive.
 */
export function builderConfig(paths: BuilderPaths): Configuration {
  return {
    appId: 'ar.consulvia.desktop',
    productName: 'Consulvia',
    copyright: 'Consulvia',
    directories: { buildResources: paths.buildDir, output: paths.outputDir },
    asar: true,
    // The shell is one bundled file with no native modules: there is nothing to rebuild.
    npmRebuild: false,
    nodeGypRebuild: false,
    extraResources: [
      { from: `${paths.stageDir}/api`, to: 'api' },
      // electron-builder never copies a `node_modules` that sits at the root of a folder it is given (it
      // assumes the dependency list takes care of it), so the modules of the API are a folder of their own.
      { from: `${paths.stageDir}/api/node_modules`, to: 'api/node_modules' },
      { from: `${paths.stageDir}/web`, to: 'web' },
      { from: `${paths.stageDir}/postgres`, to: 'postgres' },
      { from: `${paths.stageDir}/tools`, to: 'tools' },
      { from: `${paths.stageDir}/sql`, to: 'sql' },
      { from: `${paths.stageDir}/icons`, to: 'icons' },
    ],
    // The language packs of Chromium that a Spanish-speaking clinic never sees.
    electronLanguages: ['es', 'es-419', 'en-US'],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: `${paths.buildDir}/icon.ico`,
      requestedExecutionLevel: 'asInvoker',
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowToChangeInstallationDirectory: false,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: 'Consulvia',
      uninstallDisplayName: 'Consulvia',
      runAfterFinish: true,
      // The data of the clinic outlives the program.
      deleteAppDataOnUninstall: false,
      installerLanguages: ['es_ES'],
      artifactName: 'Consulvia-Setup-${version}.${ext}',
    },
    publish: null,
  };
}
