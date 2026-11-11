import { describe, expect, it } from 'vitest';

import type {
  ConsentRequestRow,
  ConsentSignatureRow,
  ConsentTemplateVersionRow,
} from '../../../db/schema/consent.js';
import { signatureFingerprint, verifySignatureFingerprint } from '../domain/fingerprint.js';

import type { SignaturePayload } from './records.js';
import { factsOf } from './signed-record.js';

const request = { id: 'r-1', patientId: 'p-1' } as ConsentRequestRow;
const version = { id: 'v-1', contentHash: 'a'.repeat(64) } as ConsentTemplateVersionRow;
const signature = {
  signerKind: 'patient',
  accepted: true,
  method: 'portal',
  signedAt: new Date('2026-10-19T14:00:00.000Z'),
} as ConsentSignatureRow;

const payload = (overrides: Partial<SignaturePayload> = {}): SignaturePayload => ({
  v: 2,
  representative: null,
  signerName: 'Ana Pérez',
  mark: { kind: 'typed', value: 'Ana Pérez' },
  markDigest: 'b'.repeat(64),
  evidence: { ip: null, userAgent: null, requestId: null },
  ...overrides,
});

describe('the facts a stored signature is verified against (JD-S5 R2, A-W3)', () => {
  it('detects a signer name changed in the stored record of the second version', () => {
    const stored = signatureFingerprint(factsOf(request, version, signature, payload()));

    expect(
      verifySignatureFingerprint(factsOf(request, version, signature, payload()), stored),
    ).toBe(true);
    expect(
      verifySignatureFingerprint(
        factsOf(request, version, signature, payload({ signerName: 'Eva Pérez' })),
        stored,
      ),
    ).toBe(false);
    // Taking the name out is a change too.
    const withoutName = payload();
    delete withoutName.signerName;
    expect(
      verifySignatureFingerprint(factsOf(request, version, signature, withoutName), stored),
    ).toBe(false);
  });

  it('still verifies a record of the first version, signed before the name was covered', () => {
    const first = payload({ v: 1 });
    const stored = signatureFingerprint(factsOf(request, version, signature, first));

    expect(verifySignatureFingerprint(factsOf(request, version, signature, first), stored)).toBe(
      true,
    );
    // The first version never covered the name: what was stored then verifies whatever it says now.
    expect(
      verifySignatureFingerprint(
        factsOf(request, version, signature, payload({ v: 1, signerName: 'Otra' })),
        stored,
      ),
    ).toBe(true);
  });
});
