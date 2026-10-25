import { provisionLocalOrganization } from '../../db/seed/local/provision.js';

import { openInstall, readInstallConfig, reportFailure } from './context.js';
import { readProvisionInput } from './input.js';
import { EXIT, finish, type CommandIo } from './io.js';

/**
 * `main.js provision`: creates the one organization of the install, or reports that it exists.
 *
 * Input: `PROVISION_ORGANIZATION_NAME`, `PROVISION_OWNER_NAME`, `PROVISION_OWNER_EMAIL`,
 * `PROVISION_OWNER_PASSWORD` and, optionally, `PROVISION_TIME_ZONE` and `PROVISION_SLUG` in the
 * environment, or the same as a JSON document (`organizationName`, `ownerName`, `ownerEmail`,
 * `ownerPassword`, `timeZone`, `slug`) on the standard input with `--stdin`. The slug is the one in
 * `SINGLE_TENANT_SLUG`; a different one in the input is refused.
 *
 * Output: `{"result":"created"|"exists","tenantId":"...","slug":"..."}` and exit 0. Anything else is
 * a JSON line on the standard error and one of the codes of `EXIT`.
 */
export async function runProvision(io: CommandIo): Promise<number> {
  const stdin = io.args.includes('--stdin') ? await io.readStdin() : undefined;
  const input = readProvisionInput({ env: io.env, stdin });
  if (!input.ok) return finish(io, EXIT.usage, { error: 'invalid_input', fields: input.fields });

  const read = readInstallConfig(io);
  if (!read.ok) return read.code;
  const { config } = read;
  if (input.value.slug !== undefined && input.value.slug !== config.singleTenantSlug) {
    return finish(io, EXIT.usage, { error: 'invalid_input', fields: ['slug'] });
  }

  let install;
  try {
    install = await openInstall(config);
  } catch (error) {
    return reportFailure(io, error);
  }
  try {
    const result = await provisionLocalOrganization(install.deps, {
      organizationName: input.value.organizationName,
      slug: config.singleTenantSlug,
      ownerName: input.value.ownerName,
      ownerEmail: input.value.ownerEmail,
      ownerPassword: input.value.ownerPassword,
      timeZone: input.value.timeZone,
    });
    return finish(io, EXIT.ok, {
      result: result.status,
      tenantId: result.tenantId,
      slug: result.slug,
    });
  } catch (error) {
    return reportFailure(io, error);
  } finally {
    await install.database.close();
  }
}
