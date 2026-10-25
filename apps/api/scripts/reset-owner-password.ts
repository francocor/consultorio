import { runCommand } from '../src/main/commands/index.js';
import { processIo } from '../src/main/commands/process-io.js';

/**
 * Gives the owner of a desktop install a new password (see `src/main/commands/reset-password.ts`).
 * The same command the bundle runs as `main.js reset-password`:
 *
 *   pnpm --filter @consultorio/api owner:reset-password --stdin < new-password.json
 *
 * The password comes from the environment or the standard input, never from the arguments.
 */
process.exitCode = await runCommand('reset-password', processIo(process.argv.slice(2)));
