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

/** A series of the authority: numbering is per issuer, point of sale and voucher type. */
export interface InvoiceSeriesRef {
  /** CUIT of the issuer (11 digits). */
  issuerCuit?: string;
  pointOfSale: number;
  /** Voucher type, for example "FA", "FB", "NCA". */
  type: string;
  /** The AFIP environment of the point of sale; an adapter that has only one ignores it. */
  environment?: 'homologation' | 'production';
  /** See `InvoiceRef.tenantRef`. */
  tenantRef?: string;
}

/**
 * What the authority answers about the last voucher of a series (FECompUltimoAutorizado in the real
 * one). `ok` carries the number of the last voucher it authorized, and 0 for a series that is empty:
 * the empty series is an answer, never an error. A lookup that fails is `retryable` (the number is not
 * known) or `rejected` (a refused question: a token, an environment); neither is ever turned into 0.
 */
export type LastAuthorizedResult =
  | { status: 'ok'; number: number }
  | { status: 'rejected'; message: string }
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

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
      /**
       * Also what a lookup says (JD-S4 R2-1): who issued the voucher, whom it is addressed to and, for
       * a credit note, the voucher it cancels. Two invoices of one series can have the same total and
       * the same date; these tell their vouchers apart. A field the lookup does not state counts as a
       * mismatch for the caller, never as a match.
       */
      issuerCuit?: string;
      /** The document of the buyer; `null` when the voucher has none. */
      buyerDocument?: { type: 'cuit' | 'dni'; number: string } | null;
      /** The voucher a credit note cancels (`cbteAsoc`); `null` when it is not a credit note. */
      associatedVoucher?: { type: string; pointOfSale: number; number: number } | null;
    }
  | { status: 'rejected'; message: string }
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

export interface InvoiceIssuer {
  /** Issues one voucher. Calling twice with the same key never produces two vouchers. */
  issue(request: InvoiceRequest, idempotencyKey: string): Promise<IssueResult>;
  /** Looks up a voucher at the authority, to reconcile a retry whose outcome is unknown. */
  findIssued(ref: InvoiceRef): Promise<IssueResult | null>;
  /**
   * The number of the last voucher the authority authorized in a series, whoever issued it (this
   * system, another tool of the same issuer, a person on the website of the authority). It is the
   * authority's own count, so the caller does not have to infer it from the vouchers it recorded
   * (JD-S4 R5-1). A series without vouchers answers `ok` with 0.
   */
  lastAuthorized(ref: InvoiceSeriesRef): Promise<LastAuthorizedResult>;
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
  | { status: 'retryable'; message: string };

export interface PrescriptionProvider {
  issue(request: PrescriptionRequest, idempotencyKey: string): Promise<PrescriptionResult>;
}
