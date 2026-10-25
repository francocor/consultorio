import { describe, expect, it } from 'vitest';

import { decideNavigation, decideWindowOpen, isSameOrigin } from './navigation-policy.js';

const APP = 'http://localhost:47800';

describe('which addresses belong to the app', () => {
  it('compares parsed origins, not the start of the text', () => {
    expect(isSameOrigin('http://localhost:47800/', APP)).toBe(true);
    expect(isSameOrigin('http://localhost:47800/agenda?x=1#y', APP)).toBe(true);
    for (const url of [
      'http://localhost:47800@evil.example/',
      'http://localhost:47800.evil.example/',
      'http://localhost:478001/',
      'https://localhost:47800/',
      'http://localhost:47801/',
      'http://127.0.0.1:47800/',
      'http://evil.example/http://localhost:47800/',
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'data:text/html,<script>1</script>',
      'not a url',
      '',
    ]) {
      expect(isSameOrigin(url, APP), url).toBe(false);
    }
  });
});

describe('where a link goes', () => {
  it('lets the app navigate within itself', () => {
    expect(decideNavigation(`${APP}/patients/1`, APP)).toEqual({ action: 'allow' });
  });

  it('sends another web address to the browser of the PC and keeps the window where it is', () => {
    expect(decideNavigation('https://www.afip.gob.ar/', APP)).toEqual({
      action: 'external',
      url: 'https://www.afip.gob.ar/',
    });
    expect(decideNavigation('http://example.org/a?b=c', APP)).toEqual({
      action: 'external',
      url: 'http://example.org/a?b=c',
    });
  });

  it("blocks the address that only starts like the app's own, and anything with credentials", () => {
    expect(decideNavigation('http://localhost:47800@evil.example/', APP)).toEqual({
      action: 'block',
    });
    expect(decideNavigation('https://user:pass@evil.example/', APP)).toEqual({ action: 'block' });
  });

  it('blocks what is not a web address at all: scripts, files, data, other programs', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///C:/Windows/System32/cmd.exe',
      'data:text/html,hi',
      'ms-msdt:/id PCWDiagnostic',
      'blob:http://localhost:47800/abc',
      'not a url',
    ]) {
      expect(decideNavigation(url, APP), url).toEqual({ action: 'block' });
    }
  });
});

describe('opening a window', () => {
  it('is denied, even to the app itself', () => {
    expect(decideWindowOpen(`${APP}/print`, APP)).toEqual({ action: 'deny' });
  });

  it('opens a web address in the browser of the PC, and denies the window', () => {
    expect(decideWindowOpen('https://example.org/x', APP)).toEqual({
      action: 'deny',
      openExternally: 'https://example.org/x',
    });
  });

  it('denies and opens nothing for a disguised or non-web address', () => {
    for (const url of [
      'http://localhost:47800@evil.example/',
      'javascript:alert(1)',
      'file:///C:/x',
    ]) {
      expect(decideWindowOpen(url, APP), url).toEqual({ action: 'deny' });
    }
  });
});
