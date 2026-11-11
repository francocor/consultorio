import { describe, expect, it } from 'vitest';

import { buildSignRequest, signingProblems, type SigningFormState } from './signing-form.js';

const VERSION = '0190a000-0000-7000-8000-0000000000d1';

const adult: SigningFormState = {
  accepted: true,
  representativeSigns: false,
  representative: { name: '', nationalId: '', relation: '' },
  mark: { kind: 'typed', name: 'Ana Pérez' },
};

const representative = { name: 'Luis Gómez', nationalId: '20123456', relation: 'padre' };

describe('signingProblems', () => {
  it('finds nothing wrong with an adult who accepted and left a mark', () => {
    expect(signingProblems(adult)).toEqual([]);
  });

  it('asks for the acceptance first, and for the mark', () => {
    expect(signingProblems({ ...adult, accepted: false, mark: null })).toEqual(['accept', 'mark']);
  });

  it('asks for all three data of the representative when one signs', () => {
    const state = { ...adult, representativeSigns: true };

    expect(signingProblems(state)).toEqual(['representative']);
    expect(signingProblems({ ...state, representative })).toEqual([]);
    expect(
      signingProblems({ ...state, representative: { ...representative, nationalId: ' 12 ' } }),
    ).toEqual(['representative']);
    expect(
      signingProblems({ ...state, representative: { ...representative, relation: '' } }),
    ).toEqual(['representative']);
  });

  it('does not look at the representative data of an adult who signs for themselves', () => {
    expect(signingProblems({ ...adult, representative })).toEqual([]);
  });
});

describe('buildSignRequest', () => {
  it('builds the signature of the patient, bound to the version that was shown', () => {
    expect(buildSignRequest(VERSION, adult)).toEqual({
      versionId: VERSION,
      accepted: true,
      signer: 'patient',
      mark: { kind: 'typed', name: 'Ana Pérez' },
    });
  });

  it('builds the signature of a representative with their trimmed data, and not as the patient', () => {
    const body = buildSignRequest(VERSION, {
      ...adult,
      representativeSigns: true,
      representative: { name: ' Luis Gómez ', nationalId: ' 20123456 ', relation: ' padre ' },
      mark: { kind: 'drawn', imageDataUrl: 'data:image/png;base64,AAAA' },
    });

    expect(body).toEqual({
      versionId: VERSION,
      accepted: true,
      signer: 'representative',
      representative,
      mark: { kind: 'drawn', imageDataUrl: 'data:image/png;base64,AAAA' },
    });
  });

  it('builds nothing while something is missing, so an incomplete form is never sent', () => {
    expect(buildSignRequest(VERSION, { ...adult, accepted: false })).toBeNull();
    expect(buildSignRequest(VERSION, { ...adult, mark: null })).toBeNull();
    expect(buildSignRequest(VERSION, { ...adult, representativeSigns: true })).toBeNull();
  });
});
