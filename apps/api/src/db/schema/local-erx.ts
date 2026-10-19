// Platform tables of the local e-prescription simulator (`ERX_PROVIDER=local`): local_erx_prescription
// and local_erx_control, track A3 (S5.04). They have no tenant_id and are never read in production,
// like `local-afip.ts`. This file is exported from index.ts already. Migration 0532 from
// `pnpm db:new 5a3 local_erx --number 0532` (docs/migration-ranges.md).
export {};
