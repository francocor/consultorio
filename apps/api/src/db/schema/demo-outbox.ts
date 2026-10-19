// The platform table `demo_outbox`, where the email fake of the demo organizations keeps what it
// captured so the demo portal code can be read inside the app, track C (S5.12, task 5.48). It has no
// tenant_id and `demo.reset` clears it. This file is exported from index.ts already. Migration 0590
// from `pnpm db:new 5c demo_outbox --number 0590` (docs/migration-ranges.md).
export {};
