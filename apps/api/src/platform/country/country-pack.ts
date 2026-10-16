import {
  fail,
  type Holiday,
  type InvoiceIssuer,
  type Matricula,
  type NationalId,
  type PayerSeed,
  type PrescriptionProvider,
  type Result,
  type TaxId,
} from '@consultorio/contracts';

// The registry below is the ONLY file allowed to import `country/ar` (enforced by ESLint boundaries).
import { createArPack } from '../../country/ar/index.js';

export type { Result };

/** Message kinds the personal-data rules talk about. */
export type MessageKind =
  'appointment_reminder' | 'appointment_confirmation' | 'whatsapp' | 'waitlist_offer';

export type PersonalDataRight =
  'access' | 'rectification' | 'update' | 'suppression' | 'formal_copy';

export interface PersonalDataRules {
  /** Data-processing consent the organization must record when it registers a patient. */
  dataProcessingConsent: { required: true; textKey: string; version: string };
  rights: readonly PersonalDataRight[];
  /** Service communications: sent without data-processing consent. */
  serviceMessages: readonly MessageKind[];
  /** Messages that need an explicit opt-in. */
  explicitOptIn: readonly MessageKind[];
  /** i18n key of the international data transfer disclosure shown in the tenant contract. */
  internationalTransferDisclosureKey: string;
}

export interface CountryDefaults {
  locale: string;
  currency: string;
  currencyDecimals: number;
  timeZone: string;
  dateFormat: string;
  decimalSeparator: string;
  thousandsSeparator: string;
}

export interface LegalAdapterDeclaration {
  port: 'InvoiceIssuer' | 'PrescriptionProvider';
  provider: string;
  /** False until the adapter is built (Stages 4 and 5). */
  implemented: boolean;
}

/**
 * Where a pack reads data that platform operators maintain without a release (holiday and payer
 * catalogs). The API implements it on top of the platform tables; tests pass a fake.
 */
export interface CatalogReader {
  holidays(country: string, year: number): Promise<Holiday[]>;
  payers(country: string): Promise<PayerSeed[]>;
}

/**
 * Everything country-specific the core needs. Capabilities ask the pack and never embed rules.
 * Only the Argentina pack exists today; the interface is what another country would implement.
 */
export interface CountryPack {
  readonly code: 'AR';
  readonly defaults: CountryDefaults;
  validateNationalId(value: string): Result<NationalId>;
  /**
   * Validates and normalizes an identity document of a patient. The type is explicit (`dni`,
   * `passport`); an unknown type is refused. The pair (type, number) is the identity key of a
   * patient inside an organization.
   */
  validateDocument(type: string, value: string): Result<{ type: string; number: string }>;
  /** Age at which a person is no longer a minor. */
  readonly majorityAge: number;
  validateTaxId(value: string): Result<TaxId>;
  /** Format only. It never proves the registration exists. */
  validateMatricula(jurisdiction: string, value: string): Result<Matricula>;
  holidays(year: number): Promise<Holiday[]>;
  payerCatalog(): Promise<PayerSeed[]>;
  readonly personalData: PersonalDataRules;
  readonly retention: { clinicalYearsAfterLastEncounter: 10 };
  readonly legalAdapters: readonly LegalAdapterDeclaration[];
  readonly invoiceIssuer?: InvoiceIssuer;
  readonly prescriptionProvider?: PrescriptionProvider;
}

/** Looks a pack up by country code. An unsupported country is refused with a clear message key. */
export function getCountryPack(code: string, catalogs: CatalogReader): Result<CountryPack> {
  switch (code) {
    case 'AR':
      return { ok: true, value: createArPack(catalogs) };
    default:
      return fail('errors.unsupported_country');
  }
}
