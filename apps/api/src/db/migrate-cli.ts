import { runMigrate } from '../main/commands/migrate.js';
import { processIo } from '../main/commands/process-io.js';

// `pnpm db:migrate`: the same command the bundle runs as `main.js migrate`.
process.exitCode = await runMigrate(processIo(process.argv.slice(2)));
