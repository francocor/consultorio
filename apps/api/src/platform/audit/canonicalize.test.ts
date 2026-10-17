import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  GENESIS_HASH,
  canonicalize,
  hashEvent,
  stableStringify,
  type CanonicalAuditRow,
} from './canonicalize.js';

const ROW: CanonicalAuditRow = {
  id: '0190a000-0000-7000-8000-000000000001',
  tenantId: '0190a000-0000-7000-8000-00000000000a',
  seq: 1,
  occurredAt: '2026-10-15T12:34:56.123456Z',
  actorUserId: '0190a000-0000-7000-8000-0000000000f1',
  actingRole: 'professional',
  action: 'clinical.note.read',
  resourceType: 'clinical_note',
  resourceId: '0190a000-0000-7000-8000-0000000000d1',
  patientId: '0190a000-0000-7000-8000-0000000000d2',
  outcome: 'allow',
  reason: 'treating',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  requestId: 'req-1',
  metadata: { version: 2, changedFields: ['phone'] },
};

describe('stableStringify', () => {
  it('sorts object keys at every depth so key order never changes the output', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(
      '{"a":{"c":[{"x":2,"y":1}],"d":2},"b":1}',
    );
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('keeps array order, nulls and scalars', () => {
    expect(stableStringify([3, 1, null, 'x', true])).toBe('[3,1,null,"x",true]');
  });
});

describe('canonicalize', () => {
  it('is a fixed-order, versioned JSON array (snapshot of the format)', () => {
    expect(canonicalize(ROW)).toBe(
      '["v1","0190a000-0000-7000-8000-000000000001","0190a000-0000-7000-8000-00000000000a",1,' +
        '"2026-10-15T12:34:56.123456Z","0190a000-0000-7000-8000-0000000000f1","professional",' +
        '"clinical.note.read","clinical_note","0190a000-0000-7000-8000-0000000000d1",' +
        '"0190a000-0000-7000-8000-0000000000d2","allow","treating","203.0.113.7","Mozilla/5.0",' +
        '"req-1","{\\"changedFields\\":[\\"phone\\"],\\"version\\":2}"]',
    );
  });

  it('does not depend on the key order of the metadata', () => {
    const reordered = { ...ROW, metadata: { changedFields: ['phone'], version: 2 } };

    expect(canonicalize(reordered)).toBe(canonicalize(ROW));
  });

  it('distinguishes a null from an empty string (no ambiguity between missing and blank)', () => {
    expect(canonicalize({ ...ROW, reason: null })).not.toBe(canonicalize({ ...ROW, reason: '' }));
  });
});

describe('hashEvent', () => {
  it('is SHA-256 of prev_hash, a newline and the canonical row', () => {
    const expected = createHash('sha256')
      .update(`${GENESIS_HASH}\n${canonicalize(ROW)}`)
      .digest('hex');

    expect(hashEvent(GENESIS_HASH, ROW)).toBe(expected);
    expect(hashEvent(GENESIS_HASH, ROW)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('has a genesis of 64 zeros', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
  });

  it.each<[string, Partial<CanonicalAuditRow>]>([
    ['the sequence number', { seq: 2 }],
    ['the timestamp', { occurredAt: '2026-10-15T12:34:56.123457Z' }],
    ['the actor', { actorUserId: '0190a000-0000-7000-8000-0000000000f2' }],
    ['the action', { action: 'clinical.note.updated' }],
    ['the patient', { patientId: null }],
    ['the outcome', { outcome: 'deny' }],
    ['the metadata', { metadata: { version: 3, changedFields: ['phone'] } }],
    ['the id', { id: '0190a000-0000-7000-8000-000000000002' }],
    ['the tenant', { tenantId: '0190a000-0000-7000-8000-00000000000b' }],
  ])('changes when %s changes', (_label, override) => {
    expect(hashEvent(GENESIS_HASH, { ...ROW, ...override })).not.toBe(hashEvent(GENESIS_HASH, ROW));
  });

  it('chains: a different previous hash gives a different hash', () => {
    const first = hashEvent(GENESIS_HASH, ROW);

    expect(hashEvent(first, ROW)).not.toBe(first);
    expect(hashEvent('f'.repeat(64), ROW)).not.toBe(hashEvent(GENESIS_HASH, ROW));
  });
});
