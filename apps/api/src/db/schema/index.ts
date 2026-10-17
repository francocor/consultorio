// Table definitions are re-exported from here, one module per bounded context. drizzle-kit reads
// this file, so a table that is not exported here never gets a migration.
export * from './access.js';
export * from './anamnesis.js';
export * from './action-token.js';
export * from './audit.js';
export * from './care.js';
export * from './coverage.js';
export * from './identity.js';
export * from './jobs.js';
export * from './operator.js';
export * from './patients.js';
export * from './platform-catalogs.js';
export * from './privacy.js';
export * from './scheduling-config.js';
export * from './staff.js';
export * from './tenant-key.js';
export * from './tenant.js';
