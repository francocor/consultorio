import { DOCUMENT_REJECTION_REASONS } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { renderRejectionEmail } from './rejection-email.js';

describe('the email that tells an uploader a file was refused', () => {
  it.each([
    ['infected', 'software malicioso'],
    ['type_not_allowed', 'tipo de archivo no está permitido'],
    ['type_mismatch', 'no coincide con el tipo'],
    ['corrupt', 'dañado'],
    ['too_large', '20 MB'],
  ] as const)('explains %s in neutral Spanish', (reason, phrase) => {
    const email = renderRejectionEmail({ organizationName: 'Centro Aillu', reason });

    expect(email.subject).toBe('Un archivo no pudo cargarse en Centro Aillu');
    expect(email.text).toContain(phrase);
    expect(email.html).toContain(phrase);
  });

  it('has a message for every reason a document can be rejected for', () => {
    for (const reason of DOCUMENT_REJECTION_REASONS) {
      const email = renderRejectionEmail({ organizationName: 'Centro', reason });
      expect(email.text.length, reason).toBeGreaterThan(80);
    }
  });

  it('escapes the organization name in the HTML part', () => {
    const email = renderRejectionEmail({
      organizationName: 'Centro <b>"Sur"</b> & Cía',
      reason: 'infected',
    });

    expect(email.html).not.toContain('<b>');
    expect(email.html).toContain('Centro &lt;b&gt;&quot;Sur&quot;&lt;/b&gt; &amp; Cía');
  });

  it('carries nothing about the file or the patient: it says what happened and where to look', () => {
    const email = renderRejectionEmail({ organizationName: 'Centro', reason: 'infected' });

    expect(email.text).toContain('Ingrese a Centro');
    expect(email.text).not.toMatch(/\.(pdf|docx?|png|jpe?g)\b/i);
  });
});
