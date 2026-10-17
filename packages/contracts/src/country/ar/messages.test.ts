import { describe, expect, it } from 'vitest';

import { validateCuit, validateNationalId, validatePassport } from './identifiers.js';
import { validateMatricula } from './matricula.js';
import { AR_VALIDATION_MESSAGES_ES_AR } from './messages.js';

function keyOf(result: { ok: boolean; error?: { i18nKey: string } }): string {
  if (result.ok || !result.error) throw new Error('expected a rejection');
  return result.error.i18nKey;
}

describe('es-AR validation messages', () => {
  it('has a non-empty message for every key a validator can return', () => {
    const keys = [
      keyOf(validateNationalId('12AB')),
      keyOf(validatePassport('x')),
      keyOf(validateCuit('20-12345678-5')),
      keyOf(validateMatricula('AR-B', 'ABC')),
      keyOf(validateMatricula('AR-ZZ', '1')),
    ];

    expect(new Set(keys).size).toBe(5);
    for (const key of keys) {
      expect(Object.keys(AR_VALIDATION_MESSAGES_ES_AR), key).toContain(key);
    }
    for (const message of Object.values(AR_VALIDATION_MESSAGES_ES_AR)) {
      expect(message.length).toBeGreaterThan(10);
    }
  });
});
