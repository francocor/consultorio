import {
  createPasswordPolicy,
  createPasswordValidator,
  loadCommonPasswords,
  type PasswordValidator,
} from '../modules/identity/domain/password-policy.js';
import { createRangeCheck } from '../modules/identity/infrastructure/breached-passwords.js';

import { findAsset } from './assets.js';

/**
 * Composition root for the password rules: the bundled list of common passwords, always, and the
 * optional breach range check when the deployment turns it on. Loading the list is part of
 * startup: if it cannot be read the process stops instead of running with a weaker policy.
 */
export async function loadPasswordValidator(options: {
  breachCheck: boolean;
}): Promise<PasswordValidator> {
  const common = await loadCommonPasswords(findAsset('common-passwords-100k.txt'));
  return createPasswordValidator(
    createPasswordPolicy(common),
    options.breachCheck ? createRangeCheck() : undefined,
  );
}
