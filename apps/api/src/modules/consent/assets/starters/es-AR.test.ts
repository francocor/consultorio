import { CONSENT_BODY_MAX_LENGTH, CONSENT_TITLE_MAX_LENGTH } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { templateFingerprint } from '../../domain/fingerprint.js';

import { CONSENT_STARTERS, findStarter } from './es-AR.js';

describe('the Spanish starter templates', () => {
  it('has one starter per specialty of the product, with distinct keys', () => {
    expect(CONSENT_STARTERS.map((starter) => starter.specialty).sort()).toEqual([
      'general',
      'nutrition',
      'odontology',
      'physiotherapy',
      'psychology',
    ]);
    expect(new Set(CONSENT_STARTERS.map((starter) => starter.key)).size).toBe(
      CONSENT_STARTERS.length,
    );
  });

  it('fits the limits of a template and reads as a complete consent', () => {
    for (const starter of CONSENT_STARTERS) {
      expect(starter.title.length, starter.key).toBeLessThanOrEqual(CONSENT_TITLE_MAX_LENGTH);
      expect(starter.body.length, starter.key).toBeGreaterThan(200);
      expect(starter.body.length, starter.key).toBeLessThanOrEqual(CONSENT_BODY_MAX_LENGTH);
      expect(starter.body, starter.key).toMatch(/riesgos/i);
      expect(starter.body, starter.key).toMatch(/revocar/i);
    }
  });

  it('gives each starter a content of its own, so their fingerprints differ', () => {
    const hashes = CONSENT_STARTERS.map((starter) => templateFingerprint(starter));
    expect(new Set(hashes).size).toBe(CONSENT_STARTERS.length);
  });

  it('finds a starter by key and knows none for a key it does not ship', () => {
    expect(findStarter('odontology_extraction')?.specialty).toBe('odontology');
    expect(findStarter('does_not_exist')).toBeUndefined();
  });
});
