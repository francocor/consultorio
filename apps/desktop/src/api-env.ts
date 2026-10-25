import type { InstallConfig } from './config-store.js';
import type { DataPaths } from './paths.js';

/**
 * The environment of every process that runs the API bundle, built from "API contract for the shell" in
 * docs/desktop/design.md. Names that are not in the contract are not read by the bundle, so nothing else is
 * set; the process gets none of the variables of the shell either, only the few Windows needs to run.
 */

/** What Windows and Node need to work at all: system folders, temp folders, the path. */
const OS_VARIABLES = [
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'COMSPEC',
  'PATHEXT',
  'PATH',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'COMPUTERNAME',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
];

/** The variables of `source` that Windows needs, matched without regard to case as Windows itself does. */
export function osEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const wanted = new Set(OS_VARIABLES);
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && wanted.has(name.toUpperCase())) result[name] = value;
  }
  return result;
}

export const DATABASE_NAME = 'consultorio';

/** Everything the environment of a process depends on. */
export interface RuntimeContext {
  config: InstallConfig;
  paths: DataPaths;
  /** The port PostgreSQL listens on this run. */
  databasePort: number;
  /** The port the API listens on this run. */
  apiPort: number;
  /** The port of the local server: `PUBLIC_URL`. */
  serverPort: number;
  /** The slug to use (the setup screen may set it before it is stored). */
  slug?: string;
  /** Random per run: the API serves only requests that carry it (see `desktop-guard.ts` in the API). */
  proxySecret?: string;
}

export function publicUrl(serverPort: number): string {
  return `http://localhost:${String(serverPort)}`;
}

function databaseUrl(role: string, password: string, port: number): string {
  return `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${String(port)}/${DATABASE_NAME}`;
}

export class MissingSlugError extends Error {
  constructor() {
    super('The organization slug is not known yet');
    this.name = 'MissingSlugError';
  }
}

/** The variables `api`, `worker`, `provision` and `reset-password` share. */
function installEnvironment(context: RuntimeContext): NodeJS.ProcessEnv {
  const slug = context.slug ?? context.config.slug;
  if (slug === null) throw new MissingSlugError();
  const { secrets } = context.config;
  return {
    ...osEnvironment(),
    NODE_ENV: 'production',
    DEPLOYMENT_PROFILE: 'desktop',
    DEPLOYMENT_MODE: 'single',
    SINGLE_TENANT_SLUG: slug,
    PUBLIC_URL: publicUrl(context.serverPort),
    DATABASE_URL: databaseUrl('app_rw', secrets.appRwPassword, context.databasePort),
    KMS_PROVIDER: 'local',
    KMS_LOCAL_KEK_BASE64: secrets.kmsLocalKekBase64,
    ADDRESS_HASH_PEPPER: secrets.addressHashPepper,
    STORAGE_DIR: context.paths.files,
    STORAGE_UPLOAD_SECRET: secrets.storageUploadSecret,
    OUTBOX_DIR: context.paths.outbox,
  };
}

export type LongRunningRole = 'api' | 'worker';

/** The environment of the API or the worker. Only the worker holds the login that seals the audit trail. */
export function longRunningEnvironment(
  role: LongRunningRole,
  context: RuntimeContext,
): NodeJS.ProcessEnv {
  const env = installEnvironment(context);
  env['HOST'] = '127.0.0.1';
  env['LOG_LEVEL'] = 'info';
  if (role === 'api') {
    env['PORT'] = String(context.apiPort);
    if (context.proxySecret !== undefined) env['DESKTOP_PROXY_SECRET'] = context.proxySecret;
  } else {
    env['AUDIT_SEALER_DATABASE_URL'] = databaseUrl(
      'audit_sealer',
      context.config.secrets.auditSealerPassword,
      context.databasePort,
    );
  }
  return env;
}

/** The environment of `provision` and `reset-password`. */
export function commandEnvironment(context: RuntimeContext): NodeJS.ProcessEnv {
  return installEnvironment(context);
}

/** The environment of `migrate`: only the owner login (and where the migrations are, when not beside `main.js`). */
export function migrateEnvironment(
  context: Pick<RuntimeContext, 'config' | 'databasePort'>,
  migrationsDir?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...osEnvironment(),
    MIGRATION_DATABASE_URL: databaseUrl(
      'app_owner',
      context.config.secrets.appOwnerPassword,
      context.databasePort,
    ),
  };
  if (migrationsDir !== undefined) env['MIGRATIONS_DIR'] = migrationsDir;
  return env;
}
