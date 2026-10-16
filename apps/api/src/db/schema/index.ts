// Table definitions are re-exported from here, one module per bounded context. drizzle-kit reads
// this file, so a table that is not exported here never gets a migration.
export * from './platform-catalogs.js';
export * from './tenant.js';
