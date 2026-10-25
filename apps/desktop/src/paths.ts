import { isAbsolute, join } from 'node:path';

/** Where an install keeps everything. All of it lives under `root`, except the backups. */
export interface DataPaths {
  /** `%APPDATA%\Consulvia`, or `CONSULVIA_DATA_DIR`. */
  root: string;
  pgdata: string;
  /** `STORAGE_DIR` of the API: the documents. */
  files: string;
  /** `OUTBOX_DIR` of the API: the mail that has no mail server. */
  outbox: string;
  logs: string;
  /** The secrets (encrypted with the Windows account) and the settings of the install. */
  configFile: string;
  /** The Chromium profile of the window (cache, cookies, service worker). Not backed up. */
  electronProfile: string;
  /** `Documents\Consulvia\Copias`, or `CONSULVIA_BACKUP_DIR`. */
  backups: string;
}

export interface PathSources {
  env: NodeJS.ProcessEnv;
  /** `app.getPath('appData')` */
  appData: string;
  /** `app.getPath('documents')` */
  documents: string;
}

function override(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

/**
 * The folders of an install. `CONSULVIA_DATA_DIR` and `CONSULVIA_BACKUP_DIR` move them, which is how the
 * tests of the installer run beside a real install without touching it.
 */
export function resolveDataPaths({ env, appData, documents }: PathSources): DataPaths {
  const root = override(env, 'CONSULVIA_DATA_DIR') ?? join(appData, 'Consulvia');
  return {
    root,
    pgdata: join(root, 'pgdata'),
    files: join(root, 'files'),
    outbox: join(root, 'outbox'),
    logs: join(root, 'logs'),
    configFile: join(root, 'config.json'),
    electronProfile: join(root, 'electron-profile'),
    backups: override(env, 'CONSULVIA_BACKUP_DIR') ?? join(documents, 'Consulvia', 'Copias'),
  };
}
