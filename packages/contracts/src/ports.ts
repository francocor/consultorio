/**
 * Legal-integration ports, declared here and implemented in later stages (design section 6).
 * They are type-only on purpose: Stage 1 fixes the shape the country pack exposes, and no adapter
 * exists until the owner has the matching external account (see docs/external-dependencies.md).
 * Until then the demo tenant and the tests use fakes.
 */

/** Reference to an already issued invoice, used to reconcile after an outage. */
export interface InvoiceRef {
  /** CUIT of the issuer (11 digits): numbering is per issuer, point of sale and type. */
  issuerCuit?: string;
  pointOfSale: number;
  /** Voucher type, for example "FA", "FB", "NCA". */
  type: string;
  number: number;
  /**
   * An opaque reference to the organization that asks, derived by the server. The real authority
   * identifies the issuer by its CUIT and ignores it; a simulator serves many organizations and uses
   * it to keep their series and their answers apart, even when two of them name the same CUIT.
   */
  tenantRef?: string;
}

export interface InvoiceRequest {
  /** CUIT of the issuer (11 digits). The adapter serves every organization, so the request names it. */
  issuerCuit?: string;
  /** The organization that asks: see `InvoiceRef.tenantRef`. */
  tenantRef?: string;
  /** The AFIP environment of the point of sale; an adapter that has only one ignores it. */
  environment?: 'homologation' | 'production';
  pointOfSale: number;
  type: string;
  /** ISO date (YYYY-MM-DD) in the location time zone. */
  issueDate: string;
  currency: string;
  totalCents: number;
  /** CUIT/CUIL or DNI of the buyer, when the voucher type needs one. */
  buyerDocument?: { type: 'cuit' | 'dni'; number: string };
  /** Name of the buyer, when the voucher type needs one. */
  buyerName?: string;
  /** Tax condition of the buyer: it decides the voucher type A, B or C. */
  buyerTaxCondition?: 'consumidor_final' | 'responsable_inscripto' | 'monotributo' | 'exento';
  /** Generic wording of the service (never clinical). */
  concept?: string;
  /** Breakdown of the total: net + VAT + exempt must add up to `totalCents` when given. */
  netCents?: number;
  vatCents?: number;
  exemptCents?: number;
  /**
   * The highest number the organization already holds for this point of sale and type (its own
   * vouchers and the registered ones). A simulator that lost its memory (a restart, a reset)
   * numbers after it, so a new voucher never collides with an earlier one. The real authority
   * decides the number by itself and ignores it. It is not part of the request that an idempotency
   * key stands for: a retry whose hint has moved gets the same voucher.
   */
  lastKnownNumber?: number;
  /** For a credit note: the voucher it cancels (the authority wants it associated). */
  associatedVoucher?: { type: string; pointOfSale: number; number: number };
}

export type IssueResult =
  | {
      status: 'issued';
      number: number;
      cae: string;
      caeExpiresOn: string;
      /**
       * What the authority holds for the voucher, when it says (a lookup always does): the caller
       * compares them with its own invoice before it adopts a voucher it did not just request.
       */
      totalCents?: number;
      issueDate?: string;
    }
  | { status: 'rejected'; message: string }
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

export interface InvoiceIssuer {
  /** Issues one voucher. Calling twice with the same key never produces two vouchers. */
  issue(request: InvoiceRequest, idempotencyKey: string): Promise<IssueResult>;
  /** Looks up a voucher at the authority, to reconcile a retry whose outcome is unknown. */
  findIssued(ref: InvoiceRef): Promise<IssueResult | null>;
}

export interface PrescriptionRequest {
  /** Professional registration data the provider requires (see the country pack). */
  matricula: { jurisdiction: string; number: string };
  patientDocument: { type: 'dni' | 'passport'; number: string };
  /** Prescription lines as text. The content is clinical: it never goes to logs or audit metadata. */
  items: readonly string[];
}

export type PrescriptionResult =
  | { status: 'issued'; externalId: string; documentUrl: string }
  | { status: 'rejected'; message: string }
  /**
   * The provider could not say. `outcomeUnknown` is true when it may have issued the prescription
   * and lost the answer: the caller asks `findByKey` before it tries again, so one prescription
   * is never issued twice.
   */
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

/** Where a prescription stands at the provider. A prescription that is not issued yet has none. */
export type ProviderPrescriptionState = 'issued' | 'cancelled' | 'dispensed' | 'expired';

export type PrescriptionStatusResult =
  | {
      status: 'found';
      externalId: string;
      state: ProviderPrescriptionState;
      /** The reason given when it was cancelled. */
      cancelReason?: string;
    }
  /** The provider holds no prescription with that id. */
  | { status: 'unknown' }
  | { status: 'retryable'; message: string };

export type PrescriptionCancelResult =
  | { status: 'cancelled'; externalId: string }
  /** The provider refuses: the prescription was dispensed or expired, or it is not known. */
  | { status: 'rejected'; message: string }
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

/**
 * The authorized e-prescription platform (Ley 27.553). Every idempotency key is global: the server
 * derives it from the organization and the prescription, so a provider that serves many
 * organizations keeps their prescriptions apart without being told who asks.
 */
export interface PrescriptionProvider {
  /** Issues one prescription. Calling twice with the same key never produces two prescriptions. */
  issue(request: PrescriptionRequest, idempotencyKey: string): Promise<PrescriptionResult>;
  /** Cancels an issued prescription with a reason. Calling twice with the same key answers the same. */
  cancel(
    externalId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<PrescriptionCancelResult>;
  /**
   * The prescription the provider issued for a key, or null when it never issued one. A retry
   * calls it first, so an answer that was lost does not become a second prescription.
   */
  findByKey(idempotencyKey: string): Promise<PrescriptionResult | null>;
  /** Where a prescription stands at the provider (issued, cancelled, dispensed, expired). */
  status(externalId: string): Promise<PrescriptionStatusResult>;
}
