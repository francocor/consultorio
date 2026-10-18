import { describe, expect, it } from 'vitest';

import { CreateTenantPayerRequest, UpdateTenantPayerRequest } from './billing.js';

const CATALOG_PAYER = '0190a000-0000-7000-8000-0000000000c1';

describe('the CUIT of a payer in the requests', () => {
  it('may come with the payer that is copied from the catalog or named by the organization', () => {
    expect(
      CreateTenantPayerRequest.parse({ payerId: CATALOG_PAYER, cuit: ' 30-70857833-5 ' }),
    ).toEqual({
      payerId: CATALOG_PAYER,
      cuit: '30-70857833-5',
    });
    expect(
      CreateTenantPayerRequest.parse({ customName: 'Mutual del Barrio', cuit: '30708578335' }),
    ).toMatchObject({
      cuit: '30708578335',
    });
    expect(CreateTenantPayerRequest.parse({ customName: 'Mutual del Barrio' })).toEqual({
      customName: 'Mutual del Barrio',
    });
  });

  it('is set, removed or left alone when a payer is updated, together with its state or alone', () => {
    expect(UpdateTenantPayerRequest.parse({ active: false })).toEqual({ active: false });
    expect(UpdateTenantPayerRequest.parse({ cuit: '30-70857833-5' })).toEqual({
      cuit: '30-70857833-5',
    });
    expect(UpdateTenantPayerRequest.parse({ cuit: null })).toEqual({ cuit: null });
    expect(UpdateTenantPayerRequest.parse({ active: true, cuit: '30708578335' })).toMatchObject({
      active: true,
    });
  });

  it('refuses an update that changes nothing, an empty CUIT and fields it does not know', () => {
    expect(UpdateTenantPayerRequest.safeParse({}).success).toBe(false);
    expect(UpdateTenantPayerRequest.safeParse({ cuit: '   ' }).success).toBe(false);
    expect(UpdateTenantPayerRequest.safeParse({ name: 'Otra' }).success).toBe(false);
    expect(
      CreateTenantPayerRequest.safeParse({ payerId: CATALOG_PAYER, customName: 'Ambos' }).success,
    ).toBe(false);
  });
});
