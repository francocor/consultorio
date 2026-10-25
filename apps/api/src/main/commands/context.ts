import { LocalProvisionError, type LocalProvisionDeps } from '../../db/seed/local/provision.js';
import { createPasswordHasher } from '../../modules/identity/index.js';
import { createTenantKeys } from '../../platform/crypto/tenant-keys.js';
import { createRuntimeDb, type DbHandle } from '../../platform/db/pool.js';
import { createWithTenant } from '../../platform/db/tenant-context.js';
import { ConfigError, loadConfig, type Config } from '../config.js';
import { createKeyManagement } from '../key-management.js';
import { loadPasswordValidator } from '../password-validator.js';

import { EXIT, finish, type CommandIo } from './io.js';

/** A command opens the database with a pool of its own, this small: it runs one transaction at a time. */
const COMMAND_POOL_MAX = 4;

/** What provisioning needs to know about the install, from the same environment the API gets. */
export type InstallConfig = Config & { singleTenantSlug: string };

/**
 * Reads the configuration of the install, or reports why it is not valid. The install is one
 * organization: these commands need single mode and the slug it is pinned to.
 */
export function readInstallConfig(
  io: CommandIo,
): { ok: true; config: InstallConfig } | { ok: false; code: number } {
  let config: Config;
  try {
    config = loadConfig(io.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return {
        ok: false,
        code: finish(io, EXIT.config, { error: 'invalid_config', message: error.message }),
      };
    }
    throw error;
  }
  if (config.deploymentMode !== 'single' || config.singleTenantSlug === undefined) {
    return {
      ok: false,
      code: finish(io, EXIT.config, {
        error: 'invalid_config',
        message: 'DEPLOYMENT_MODE: this command needs single mode and SINGLE_TENANT_SLUG',
      }),
    };
  }
  return { ok: true, config: { ...config, singleTenantSlug: config.singleTenantSlug } };
}

/** Opens the database and builds what the provisioning functions need. The caller closes `database`. */
export async function openInstall(
  config: Config,
): Promise<{ database: DbHandle; deps: LocalProvisionDeps }> {
  const database = createRuntimeDb(config.databaseUrl, { max: COMMAND_POOL_MAX });
  try {
    return {
      database,
      deps: {
        db: database.db,
        withTenant: createWithTenant(database.db),
        hasher: createPasswordHasher(),
        keys: createTenantKeys({ kms: createKeyManagement(config.kms) }),
        validator: await loadPasswordValidator({ breachCheck: false }),
        clock: () => new Date(),
      },
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

/** The exit code of a failure of a command: the ones it expects have their own, the rest is `1`. */
export function reportFailure(io: CommandIo, error: unknown): number {
  if (error instanceof LocalProvisionError) {
    if (error.code === 'password_rejected') {
      return finish(io, EXIT.usage, { error: error.code, issues: error.issues });
    }
    return finish(io, EXIT.refused, { error: error.code });
  }
  // The message of a driver error names the problem and never carries a connection string or a value.
  return finish(io, EXIT.failed, {
    error: 'failed',
    message: error instanceof Error ? error.message : 'unknown error',
  });
}
