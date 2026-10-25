import { describe, expect, it } from 'vitest';

import { openRecovery, RecoveryError, sealRecovery, type RecoveryPayload } from './recovery.js';
import { generateSecrets } from './secrets.js';

const payload: RecoveryPayload = {
  slug: 'consultorio',
  kmsLocalKekBase64: 'S0VLLWZvci10ZXN0cy1vbmx5LTMyLWJ5dGVzLWxvbmchISE=',
  addressHashPepper: 'pepper-for-tests-0123456789-abcdefghijkl',
  storageUploadSecret: 'upload-secret-for-tests-0123456789-abcdef',
};

describe('the secrets inside a backup', () => {
  it('open with the recovery key, however it is typed', () => {
    const { recoveryKey } = generateSecrets();
    const sealed = sealRecovery(payload, recoveryKey);

    expect(openRecovery(sealed, recoveryKey)).toEqual(payload);
    expect(openRecovery(sealed, recoveryKey.toLowerCase().replaceAll('-', ' '))).toEqual(payload);
  });

  it('do not show the values in the file', () => {
    const { recoveryKey } = generateSecrets();

    const sealed = sealRecovery(payload, recoveryKey);

    expect(sealed).not.toContain(payload.kmsLocalKekBase64);
    expect(sealed).not.toContain(payload.addressHashPepper);
  });

  it('are sealed differently every time', () => {
    const { recoveryKey } = generateSecrets();

    expect(sealRecovery(payload, recoveryKey)).not.toBe(sealRecovery(payload, recoveryKey));
  });

  it('say the key is wrong, and not that the file is damaged, when another key is used', () => {
    const sealed = sealRecovery(payload, generateSecrets().recoveryKey);

    expect(() => openRecovery(sealed, generateSecrets().recoveryKey)).toThrow(
      expect.objectContaining({ code: 'wrong_key' }),
    );
  });

  it('say the file is damaged when it is not a sealed document, or has been changed', () => {
    const { recoveryKey } = generateSecrets();
    const sealed = JSON.parse(sealRecovery(payload, recoveryKey)) as { data: string };

    expect(() => openRecovery('not json', recoveryKey)).toThrow(RecoveryError);
    expect(() => openRecovery('{"version":2}', recoveryKey)).toThrow(
      expect.objectContaining({ code: 'corrupt' }),
    );
    // A changed byte fails the authentication, which looks like a wrong key: either way nothing is returned.
    const tampered = { ...sealed, data: Buffer.from('x'.repeat(40)).toString('base64') };
    expect(() => openRecovery(JSON.stringify(tampered), recoveryKey)).toThrow(RecoveryError);
  });
});
