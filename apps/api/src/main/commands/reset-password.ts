import { resetOwnerPassword } from '../../db/seed/local/reset-password.js';
import { createTenantLookup } from '../../modules/tenancy/index.js';

import { openInstall, readInstallConfig, reportFailure } from './context.js';
import { readResetInput } from './input.js';
import { EXIT, finish, type CommandIo } from './io.js';

/**
 * `main.js reset-password`: gives the owner of the install a new password. The way back from a
 * forgotten one on a PC with no mail server; the tray runs it.
 *
 * Input: `RESET_NEW_PASSWORD` and, if the organization has more than one owner, `RESET_OWNER_EMAIL` in
 * the environment, or `{"newPassword":"...","ownerEmail":"...","clearSecondFactor":true}` on the standard
 * input with `--stdin`. `clearSecondFactor` (`RESET_CLEAR_SECOND_FACTOR`) also removes the owner's second
 * factor and recovery codes, for an owner who lost the phone.
 *
 * Output: `{"result":"reset","email":"...","secondFactorCleared":false}` and exit 0. The sessions of the
 * owner end, a lock is lifted, the second factor stays unless it was asked to go. Anything else is a
 * JSON line on the standard error and one of the codes of `EXIT`.
 */
export async function runResetPassword(io: CommandIo): Promise<number> {
  const stdin = io.args.includes('--stdin') ? await io.readStdin() : undefined;
  const input = readResetInput({ env: io.env, stdin });
  if (!input.ok) return finish(io, EXIT.usage, { error: 'invalid_input', fields: input.fields });

  const read = readInstallConfig(io);
  if (!read.ok) return read.code;

  let install;
  try {
    install = await openInstall(read.config);
  } catch (error) {
    return reportFailure(io, error);
  }
  try {
    const found = await createTenantLookup(install.database.db)(read.config.singleTenantSlug);
    if (!found) return finish(io, EXIT.refused, { error: 'organization_not_found' });
    const result = await resetOwnerPassword(install.deps, {
      tenantId: found.id,
      newPassword: input.value.newPassword,
      ownerEmail: input.value.ownerEmail,
      clearSecondFactor: input.value.clearSecondFactor,
    });
    return finish(io, EXIT.ok, {
      result: 'reset',
      email: result.email,
      secondFactorCleared: result.secondFactorCleared,
    });
  } catch (error) {
    return reportFailure(io, error);
  } finally {
    await install.database.close();
  }
}
