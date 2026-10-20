// Tables of the subscriptions module: the platform `plan` and `plan_entitlement` (no tenant_id),
// and the tenant `subscription`, `subscription_event`, `usage_record` and `statement`, track A
// (S6.01, S6.05). This file is exported from index.ts already: the track that owns it fills it in
// and adds nothing to any shared file. Migrations come from `pnpm db:new 6a <name>`
// (docs/migration-ranges.md): 0610 plans and the subscription, later ones as the slices need.
export {};
