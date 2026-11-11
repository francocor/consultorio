import { z } from 'zod';

/**
 * Contracts of payer plans and patient coverage. A payer comes from the platform catalog (obras
 * sociales, prepagas and "Particular") or is a custom entry of the organization.
 */

export const PAYER_KINDS_DTO = ['obra_social', 'prepaga', 'private'] as const;

export const PayerCatalogEntry = z.strictObject({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(PAYER_KINDS_DTO),
});
export type PayerCatalogEntry = z.infer<typeof PayerCatalogEntry>;

export const PayerCatalogResponse = z.strictObject({ payers: z.array(PayerCatalogEntry) });
export type PayerCatalogResponse = z.infer<typeof PayerCatalogResponse>;

const PlanName = z.string().trim().min(1).max(80);

/** Enable a catalog payer, or add an entry of the organization's own. Exactly one of the two. */
export const CreatePayerPlanRequest = z.union([
  z.strictObject({ payerId: z.uuid(), planName: PlanName.optional() }),
  z.strictObject({ customName: z.string().trim().min(1).max(80), planName: PlanName.optional() }),
]);
export type CreatePayerPlanRequest = z.infer<typeof CreatePayerPlanRequest>;

export const PayerPlanDto = z.strictObject({
  id: z.uuid(),
  /** The catalog payer, or null for an entry of the organization. */
  payerId: z.uuid().nullable(),
  name: z.string(),
  kind: z.enum([...PAYER_KINDS_DTO, 'custom']),
  planName: z.string().nullable(),
  active: z.boolean(),
});
export type PayerPlanDto = z.infer<typeof PayerPlanDto>;

export const PayerPlanListResponse = z.strictObject({ plans: z.array(PayerPlanDto) });
export type PayerPlanListResponse = z.infer<typeof PayerPlanListResponse>;

const IsoDate = z.iso.date();

export const CoverageInput = z.strictObject({
  payerPlanId: z.uuid(),
  /** Needed for every payer but "Particular" (self-pay). */
  memberNumber: z.string().trim().min(1).max(40).optional(),
  validFrom: IsoDate.optional(),
  validTo: IsoDate.optional(),
  /** The first coverage is primary on its own. Making another one primary demotes the old one. */
  primary: z.boolean().optional(),
});
export type CoverageInput = z.infer<typeof CoverageInput>;

export const UpdateCoverageRequest = z
  .strictObject({
    payerPlanId: z.uuid().optional(),
    memberNumber: z.string().trim().min(1).max(40).nullable().optional(),
    validFrom: IsoDate.nullable().optional(),
    validTo: IsoDate.nullable().optional(),
    primary: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateCoverageRequest = z.infer<typeof UpdateCoverageRequest>;

export const CoverageDto = z.strictObject({
  id: z.uuid(),
  payerPlanId: z.uuid(),
  payerName: z.string(),
  payerKind: z.enum([...PAYER_KINDS_DTO, 'custom']),
  planName: z.string().nullable(),
  memberNumber: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  primary: z.boolean(),
  /** Past its validity date: shown flagged, and never used as the default. */
  expired: z.boolean(),
});
export type CoverageDto = z.infer<typeof CoverageDto>;

export const CoverageListResponse = z.strictObject({
  coverages: z.array(CoverageDto),
  /** The coverage later features use by default: the primary one, if it has not expired. */
  defaultCoverageId: z.uuid().nullable(),
});
export type CoverageListResponse = z.infer<typeof CoverageListResponse>;
