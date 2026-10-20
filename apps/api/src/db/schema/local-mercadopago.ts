// Platform tables of the local Mercado Pago simulator (`PAYMENTS_PROVIDER=local`):
// local_mp_preapproval, local_mp_payment and local_mp_control, track A (S6.03). They have no
// tenant_id and are never read in production, like `local-afip.ts` and `local-erx.ts`. This file
// is exported from index.ts already. Migration 0612 from
// `pnpm db:new 6a local_mercadopago --number 0612` (docs/migration-ranges.md).
export {};
