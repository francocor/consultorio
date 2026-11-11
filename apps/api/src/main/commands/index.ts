import { EXIT, finish, type CommandIo } from './io.js';
import { runMigrate } from './migrate.js';
import { runProvision } from './provision.js';
import { runResetPassword } from './reset-password.js';

/**
 * The commands of `main.js` besides the three long-running processes (`api`, `worker`, `releaser`):
 * the one-shot jobs the desktop shell runs around them. Each reads its input from the environment
 * (and, for the two that take a password, from a JSON document on the standard input with `--stdin`),
 * never from the arguments, writes ONE JSON line to the standard output when it worked and ONE to the
 * standard error when it did not, and tells the shell what happened by its exit code.
 */
export const COMMAND_NAMES = ['provision', 'reset-password', 'migrate'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export function isCommandName(value: string | undefined): value is CommandName {
  return COMMAND_NAMES.some((name) => name === value);
}

export { EXIT, finish, type CommandIo };

export function runCommand(name: CommandName, io: CommandIo): Promise<number> {
  switch (name) {
    case 'provision':
      return runProvision(io);
    case 'reset-password':
      return runResetPassword(io);
    case 'migrate':
      return runMigrate(io);
  }
}
