import { runCommand } from '../src/main/commands/index.js';
import { processIo } from '../src/main/commands/process-io.js';

/**
 * Creates the organization of a desktop install (see `src/main/commands/provision.ts` for the input,
 * the output and the exit codes). The same command the bundle runs as `main.js provision`:
 *
 *   pnpm --filter @consultorio/api provision:local --stdin < organization.json
 *
 * The password comes from the environment or the standard input, never from the arguments.
 */
process.exitCode = await runCommand('provision', processIo(process.argv.slice(2)));
