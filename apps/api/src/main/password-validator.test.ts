import { describe, expect, it } from 'vitest';

import { loadPasswordValidator } from './password-validator.js';

describe('the password validator of the application', () => {
  it('rejects the passwords everyone knows and accepts a passphrase', async () => {
    const validator = await loadPasswordValidator({ breachCheck: false });

    expect(await validator.validate('1234567890')).toEqual({ ok: false, issues: ['common'] });
    expect(await validator.validate('una frase larga que nadie usa 2026')).toEqual({ ok: true });
  });
});
