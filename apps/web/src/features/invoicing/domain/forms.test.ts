import { describe, expect, it } from 'vitest';

import {
  EMPTY_PROFILE,
  missingProfileFields,
  parsePointOfSale,
  profileRequest,
  sameProfile,
} from './forms.js';

const complete = {
  cuit: ' 20-12345678-6 ',
  taxCondition: 'monotributo',
  businessName: ' Consultorio Aillu ',
  address: 'Av. Siempre Viva 123',
  activityStartedOn: '2020-03-01',
} as const;

describe('the fiscal profile draft', () => {
  it('lists every field of an empty form as missing', () => {
    expect(missingProfileFields(EMPTY_PROFILE)).toEqual([
      'cuit',
      'taxCondition',
      'businessName',
      'address',
      'activityStartedOn',
    ]);
  });

  it('lists only the fields that are empty or blank', () => {
    expect(missingProfileFields({ ...complete, address: '   ', activityStartedOn: '' })).toEqual([
      'address',
      'activityStartedOn',
    ]);
  });

  it('builds the request from a complete draft, trimmed, and none from an incomplete one', () => {
    expect(profileRequest(complete)).toEqual({
      cuit: '20-12345678-6',
      taxCondition: 'monotributo',
      businessName: 'Consultorio Aillu',
      address: 'Av. Siempre Viva 123',
      activityStartedOn: '2020-03-01',
    });
    expect(profileRequest({ ...complete, taxCondition: '' })).toBeNull();
    expect(profileRequest(EMPTY_PROFILE)).toBeNull();
  });

  it('tells a changed draft from an unchanged one', () => {
    expect(sameProfile(complete, { ...complete })).toBe(true);
    expect(sameProfile(complete, { ...complete, businessName: 'Otro' })).toBe(false);
  });
});

describe('the point of sale number', () => {
  it.each([
    ['1', 1],
    [' 12 ', 12],
    ['99999', 99999],
    ['0', null],
    ['100000', null],
    ['1.5', null],
    ['-3', null],
    ['', null],
    ['abc', null],
  ])('%j reads as %j', (text, expected) => {
    expect(parsePointOfSale(text)).toBe(expected);
  });
});
