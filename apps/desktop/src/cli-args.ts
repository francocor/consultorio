/**
 * What a second launch of the program can ask the first one (the first is the install that is running;
 * the second only passes its command line along and exits). They are the same switches the tests of the
 * installer use to drive a real install from outside.
 *
 *   --quit             stop everything and exit, as "Salir" does
 *   --backup           make a backup now
 *   --reset-password   open the page that resets the owner's password, as the tray does
 *   --restore=<file>   restore a backup (the confirmation is skipped only in test mode)
 *   --hidden           start without showing the window (Windows login)
 */
export type LaunchRequest =
  | { kind: 'show' }
  | { kind: 'quit' }
  | { kind: 'backup' }
  | { kind: 'reset-password' }
  | { kind: 'restore'; file: string };

export interface ParsedArgs {
  request: LaunchRequest;
  hidden: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let request: LaunchRequest = { kind: 'show' };
  let hidden = false;
  for (const argument of argv) {
    if (argument === '--quit') request = { kind: 'quit' };
    else if (argument === '--backup') request = { kind: 'backup' };
    else if (argument === '--reset-password') request = { kind: 'reset-password' };
    else if (argument === '--hidden') hidden = true;
    else if (argument.startsWith('--restore=') && argument.length > '--restore='.length) {
      request = { kind: 'restore', file: argument.slice('--restore='.length) };
    }
  }
  return { request, hidden };
}
