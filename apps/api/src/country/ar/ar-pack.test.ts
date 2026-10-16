import type { Holiday, PayerSeed } from '@consultorio/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogReader } from '../../platform/country/country-pack.js';

import { createArPack } from './index.js';

const HOLIDAY: Holiday = {
  country: 'AR',
  date: '2026-12-25',
  name: 'Navidad',
  kind: 'national',
};
const PAYER: PayerSeed = { country: 'AR', code: 'osde', name: 'OSDE', kind: 'prepaga' };

const holidaysMock = vi.fn(() => Promise.resolve([HOLIDAY]));
const payersMock = vi.fn(() => Promise.resolve([PAYER]));

function catalogs(): CatalogReader {
  return { holidays: holidaysMock, payers: payersMock };
}

describe('Argentina country pack', () => {
  it('identifies itself as AR with the es-AR defaults', () => {
    const pack = createArPack(catalogs());

    expect(pack.code).toBe('AR');
    expect(pack.defaults).toEqual({
      locale: 'es-AR',
      currency: 'ARS',
      currencyDecimals: 2,
      timeZone: 'America/Argentina/Buenos_Aires',
      dateFormat: 'dd/MM/yyyy',
      decimalSeparator: ',',
      thousandsSeparator: '.',
    });
  });

  it('keeps clinical records for 10 years after the last encounter', () => {
    expect(createArPack(catalogs()).retention).toEqual({ clinicalYearsAfterLastEncounter: 10 });
  });

  it('validates identifiers through the shared contracts implementation', () => {
    const pack = createArPack(catalogs());

    expect(pack.validateNationalId('30.123.456')).toEqual({ ok: true, value: '30123456' });
    expect(pack.validateNationalId('12AB').ok).toBe(false);
    expect(pack.validateTaxId('20-12345678-6')).toEqual({ ok: true, value: '20123456786' });
    expect(pack.validateTaxId('20-12345678-5').ok).toBe(false);
    expect(pack.validateMatricula('AR-B', 'MP 123456')).toEqual({
      ok: true,
      value: { jurisdiction: 'AR-B', number: '123456' },
    });
    expect(pack.validateMatricula('AR-B', 'x').ok).toBe(false);
  });

  it('reads holidays and payers from the platform catalogs, not from code', async () => {
    const pack = createArPack(catalogs());

    await expect(pack.holidays(2026)).resolves.toEqual([HOLIDAY]);
    await expect(pack.payerCatalog()).resolves.toEqual([PAYER]);
    expect(holidaysMock).toHaveBeenCalledWith('AR', 2026);
    expect(payersMock).toHaveBeenCalledWith('AR');
  });

  it('states which messages are service communications and which need explicit opt-in', () => {
    const { personalData } = createArPack(catalogs());

    expect(personalData.serviceMessages).toEqual([
      'appointment_reminder',
      'appointment_confirmation',
    ]);
    expect(personalData.explicitOptIn).toEqual(['whatsapp', 'waitlist_offer']);
    expect(personalData.dataProcessingConsent).toMatchObject({
      required: true,
      textKey: 'consent.data_processing.ar',
    });
    expect(personalData.rights).toEqual(
      expect.arrayContaining(['access', 'rectification', 'formal_copy']),
    );
    // No message kind is both a free service message and an opt-in one.
    expect(
      personalData.serviceMessages.filter((kind) =>
        (personalData.explicitOptIn as readonly string[]).includes(kind),
      ),
    ).toEqual([]);
  });

  it('declares the legal adapters but implements none of them yet', () => {
    const pack = createArPack(catalogs());

    expect(pack.legalAdapters).toEqual([
      { port: 'InvoiceIssuer', provider: 'afip-wsfe', implemented: false },
      { port: 'PrescriptionProvider', provider: 'e-rx', implemented: false },
    ]);
    expect(pack.invoiceIssuer).toBeUndefined();
    expect(pack.prescriptionProvider).toBeUndefined();
  });
});
