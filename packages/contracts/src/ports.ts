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
}

export interface InvoiceRequest {
  /** CUIT of the issuer (11 digits). The adapter serves every organization, so the request names it. */
  issuerCuit?: string;
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
}

export type IssueResult =
  | { status: 'issued'; number: number; cae: string; caeExpiresOn: string }
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
  | { status: 'retryable'; message: string };

export interface PrescriptionProvider {
  issue(request: PrescriptionRequest, idempotencyKey: string): Promise<PrescriptionResult>;
}
