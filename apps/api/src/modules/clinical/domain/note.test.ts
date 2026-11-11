import { describe, expect, it } from 'vitest';

import { headlineOf, noteAccess, type AccessInput } from './note.js';

const ME: AccessInput = {
  status: 'draft',
  isAuthor: true,
  treating: true,
  tenantActive: true,
};

describe('noteAccess: what a reader may do with an entry', () => {
  it('lets the author edit and sign their own draft', () => {
    expect(noteAccess(ME)).toEqual({
      basis: 'author',
      canEdit: true,
      canSign: true,
      canAddAddendum: false,
      canMarkError: true,
      rectificationOnly: false,
    });
  });

  it('gives a signed entry no edit and no sign, to anybody', () => {
    for (const isAuthor of [true, false]) {
      const access = noteAccess({ ...ME, status: 'signed', isAuthor });
      expect(access.canEdit).toBe(false);
      expect(access.canSign).toBe(false);
    }
  });

  it('lets a treating professional (author or not) add an addendum to a signed entry', () => {
    expect(noteAccess({ ...ME, status: 'signed' }).canAddAddendum).toBe(true);
    expect(noteAccess({ ...ME, status: 'signed', isAuthor: false }).canAddAddendum).toBe(true);
  });

  it('keeps a reader who has the entry only through sharing read-only', () => {
    const access = noteAccess({
      status: 'signed',
      isAuthor: false,
      treating: false,
      tenantActive: true,
    });

    expect(access).toEqual({
      basis: 'shared',
      canEdit: false,
      canSign: false,
      canAddAddendum: false,
      canMarkError: false,
      rectificationOnly: false,
    });
  });

  it('lets another treating professional mark a signed entry in error, but not somebody elses draft', () => {
    expect(noteAccess({ ...ME, status: 'signed', isAuthor: false }).canMarkError).toBe(true);
    expect(noteAccess({ ...ME, status: 'draft', isAuthor: false }).canMarkError).toBe(false);
  });

  it('allows nothing on an entry marked in error', () => {
    const access = noteAccess({ ...ME, status: 'entered_in_error' });

    expect(access).toMatchObject({
      canEdit: false,
      canSign: false,
      canAddAddendum: false,
      canMarkError: false,
    });
  });

  it('in a read-only organization allows only the rectification addendum (D16)', () => {
    const signed = noteAccess({ ...ME, status: 'signed', tenantActive: false });
    const draft = noteAccess({ ...ME, status: 'draft', tenantActive: false });

    expect(signed).toMatchObject({
      canAddAddendum: true,
      rectificationOnly: true,
      canMarkError: false,
    });
    expect(draft).toMatchObject({ canEdit: false, canSign: false, canMarkError: false });
  });
});

describe('headlineOf', () => {
  it('uses the first thing the entry says, by importance', () => {
    expect(headlineOf({ reasonForConsultation: 'Control anual', diagnosis: 'Sano' })).toBe(
      'Control anual',
    );
    expect(headlineOf({ topics: 'Ansiedad laboral' })).toBe('Ansiedad laboral');
    expect(headlineOf({ affectedRegion: 'Rodilla derecha', painIntensity: 6 })).toBe(
      'Rodilla derecha',
    );
  });

  it('skips blank text and returns null when there is none', () => {
    expect(headlineOf({ reasonForConsultation: '  ', diagnosis: 'Gripe' })).toBe('Gripe');
    expect(headlineOf({ painIntensity: 4 })).toBeNull();
    expect(headlineOf({})).toBeNull();
  });

  it('cuts a long first line and keeps only its first line', () => {
    const headline = headlineOf({ reasonForConsultation: `${'a'.repeat(300)}\nsegunda línea` });

    expect(headline?.length).toBe(160);
    expect(headline?.endsWith('…')).toBe(true);
    expect(headlineOf({ reasonForConsultation: 'Primera\nSegunda' })).toBe('Primera');
  });
});
