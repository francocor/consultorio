import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canonicalText,
  signatureFingerprint,
  templateFingerprint,
  verifySignatureFingerprint,
  type SignedFacts,
} from './fingerprint.js';

describe('canonicalText', () => {
  it('turns every kind of line break into one, and drops the blank lines at both ends', () => {
    expect(canonicalText('\r\n\r\nUno\r\nDos\rTres\n\n')).toBe('Uno\nDos\nTres');
  });

  it('drops the spaces at the end of a line but keeps the ones inside it', () => {
    expect(canonicalText('Autorizo  el   procedimiento   \nFirma\t')).toBe(
      'Autorizo  el   procedimiento\nFirma',
    );
  });

  it('writes accents in one form, so a pasted decomposed character is the same text', () => {
    const decomposed = 'Extracción'; // o + combining acute accent
    expect(canonicalText(decomposed)).toBe('Extracción');
  });

  it('keeps a blank line between paragraphs: it is part of what the patient reads', () => {
    expect(canonicalText('Uno\n\nDos')).toBe('Uno\n\nDos');
    expect(canonicalText('Uno\n\nDos')).not.toBe(canonicalText('Uno\nDos'));
  });
});

describe('templateFingerprint', () => {
  const base = {
    title: 'Extracción dental',
    body: 'Autorizo la extracción.\nEntiendo los riesgos.',
  };

  it('is the SHA-256 of the canonical content, in hexadecimal', () => {
    const hash = templateFingerprint(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          body: 'Autorizo la extracción.\nEntiendo los riesgos.',
          title: 'Extracción dental',
        }),
        'utf8',
      )
      .digest('hex');
    expect(hash).toBe(expected);
  });

  it('does not change with whitespace that does not change what is read', () => {
    const same = templateFingerprint({
      title: '  Extracción   dental ',
      body: 'Autorizo la extracción.  \r\nEntiendo los riesgos.\r\n\r\n',
    });
    expect(same).toBe(templateFingerprint(base));
  });

  it('changes with a different word, a different title or another order of the lines', () => {
    const hash = templateFingerprint(base);
    expect(
      templateFingerprint({ ...base, body: 'Autorizo la extracción.\nEntiendo el riesgo.' }),
    ).not.toBe(hash);
    expect(templateFingerprint({ ...base, title: 'Extracción de muela' })).not.toBe(hash);
    expect(
      templateFingerprint({ ...base, body: 'Entiendo los riesgos.\nAutorizo la extracción.' }),
    ).not.toBe(hash);
  });

  it('does not let the title run into the body: moving a word across them is another content', () => {
    expect(templateFingerprint({ title: 'A B', body: 'C' })).not.toBe(
      templateFingerprint({ title: 'A', body: 'B C' }),
    );
  });

  it('is deterministic (property): the same input always gives the same hash', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (title, body) => {
        return templateFingerprint({ title, body }) === templateFingerprint({ title, body });
      }),
    );
  });

  it('is stable under the whitespace it defines as equivalent (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-zÁÉÍÓÚáéíóúñ ,.]{0,30}$/), { maxLength: 6 }),
        (lines) => {
          const unix = lines.join('\n');
          const windows = lines.map((line) => `${line}  `).join('\r\n') + '\r\n\r\n';
          return (
            templateFingerprint({ title: 't', body: unix }) ===
            templateFingerprint({ title: 't', body: windows })
          );
        },
      ),
    );
  });
});

describe('signatureFingerprint', () => {
  const facts: SignedFacts = {
    requestId: '0197c0a0-0000-7000-8000-000000000001',
    patientId: '0197c0a0-0000-7000-8000-000000000002',
    versionId: '0197c0a0-0000-7000-8000-000000000003',
    versionFingerprint: 'a'.repeat(64),
    signerKind: 'patient',
    representative: null,
    accepted: true,
    method: 'in_person',
    signedAt: '2026-10-19T14:00:00.000Z',
    mark: { kind: 'typed', value: 'Ana Pérez' },
  };

  it('is a SHA-256 in hexadecimal and the same for the same facts', () => {
    expect(signatureFingerprint(facts)).toMatch(/^[0-9a-f]{64}$/);
    expect(signatureFingerprint({ ...facts })).toBe(signatureFingerprint(facts));
  });

  it('changes with any fact that makes the signed document: version, signer, time, mark', () => {
    const hash = signatureFingerprint(facts);
    const variants: SignedFacts[] = [
      { ...facts, versionFingerprint: 'b'.repeat(64) },
      { ...facts, versionId: '0197c0a0-0000-7000-8000-0000000000ff' },
      { ...facts, patientId: '0197c0a0-0000-7000-8000-0000000000fe' },
      { ...facts, method: 'portal' },
      { ...facts, signedAt: '2026-10-19T14:00:00.001Z' },
      { ...facts, mark: { kind: 'typed', value: 'Ana Perez' } },
      { ...facts, mark: { kind: 'drawn', value: 'Ana Pérez' } },
      {
        ...facts,
        signerKind: 'representative',
        representative: { name: 'Luis Pérez', nationalId: '20123456', relation: 'padre' },
      },
    ];
    for (const variant of variants) expect(signatureFingerprint(variant)).not.toBe(hash);
    expect(new Set(variants.map(signatureFingerprint)).size).toBe(variants.length);
  });

  it('tells a representative apart from another one with the same name but another document', () => {
    const representative = (nationalId: string): SignedFacts => ({
      ...facts,
      signerKind: 'representative',
      representative: { name: 'Luis Pérez', nationalId, relation: 'padre' },
    });
    expect(signatureFingerprint(representative('20123456'))).not.toBe(
      signatureFingerprint(representative('20123457')),
    );
  });

  it('verifies the stored fingerprint, and refuses one that does not match the facts', () => {
    const stored = signatureFingerprint(facts);
    expect(verifySignatureFingerprint(facts, stored)).toBe(true);
    expect(verifySignatureFingerprint({ ...facts, method: 'portal' }, stored)).toBe(false);
    expect(verifySignatureFingerprint(facts, 'c'.repeat(64))).toBe(false);
  });

  describe('the name the signer typed (JD-S5 R2, A-W3)', () => {
    const v2: SignedFacts = { ...facts, version: 2, signerName: 'Ana Pérez' };

    it('is part of what a record of the second version is a fingerprint of', () => {
      const hash = signatureFingerprint(v2);

      expect(signatureFingerprint({ ...v2, signerName: 'Eva Pérez' })).not.toBe(hash);
      expect(signatureFingerprint({ ...v2, signerName: null })).not.toBe(hash);
      expect(verifySignatureFingerprint({ ...v2, signerName: 'Eva Pérez' }, hash)).toBe(false);
      expect(verifySignatureFingerprint(v2, hash)).toBe(true);
    });

    it('reads the name in one form, as it does the other names', () => {
      expect(signatureFingerprint({ ...v2, signerName: '  Ana   Pérez ' })).toBe(
        signatureFingerprint(v2),
      );
    });

    it('is not part of a record of the first version, which still verifies as it was signed', () => {
      const first = signatureFingerprint({ ...facts, version: 1 });

      expect(signatureFingerprint({ ...facts, version: 1, signerName: 'Eva Pérez' })).toBe(first);
      // A record with no version is a first one: the fingerprints stored before the name was covered.
      expect(signatureFingerprint(facts)).toBe(first);
      expect(signatureFingerprint(v2)).not.toBe(first);
    });
  });
});
