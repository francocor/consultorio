import { describe, expect, it } from 'vitest';

import { renderConsentRequestEmail } from './request-email.js';

const input = {
  organizationName: 'Centro Aillu',
  givenNames: 'Ana',
  portalUrl: 'https://aillu.consultorio.test/portal',
};

describe('the notice that a consent is waiting', () => {
  it('says who asks and where to sign, with the link to the portal', () => {
    const email = renderConsentRequestEmail(input);

    expect(email.subject).toBe('Centro Aillu: tiene un consentimiento para firmar');
    expect(email.text).toContain('Hola Ana,');
    expect(email.text).toContain('Centro Aillu le pidió que firme un consentimiento.');
    expect(email.text).toContain('https://aillu.consultorio.test/portal');
    expect(email.html).toContain('https://aillu.consultorio.test/portal');
  });

  it('names no procedure, specialty or title: it cannot, it is never given one', () => {
    const email = renderConsentRequestEmail(input);
    const everything = `${email.subject} ${email.text} ${email.html}`.toLowerCase();

    for (const word of [
      'extracción',
      'cirugía',
      'anestesia',
      'odontolog',
      'psicolog',
      'tratamiento',
    ]) {
      expect(everything, word).not.toContain(word);
    }
  });

  it('escapes what comes from the organization and the patient in the HTML part', () => {
    const email = renderConsentRequestEmail({
      ...input,
      organizationName: 'Clínica <b>Sur</b> & Co',
      givenNames: 'Ana "la" Ñ',
    });

    expect(email.html).toContain('Clínica &lt;b&gt;Sur&lt;/b&gt; &amp; Co');
    expect(email.html).not.toContain('<b>Sur</b>');
    expect(email.html).toContain('Ana &quot;la&quot; Ñ');
  });
});
