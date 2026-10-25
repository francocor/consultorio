/* Shared by every command: how it talks to the shell that started it. */

/** The exit codes of the commands. `1` is anything that was not expected: the database is down. */
export const EXIT = {
  ok: 0,
  failed: 1,
  /** The input is wrong or missing; the password breaks the rules. The user can fix it. */
  usage: 2,
  /** The environment is not a valid configuration. A bug of the shell, not of the user. */
  config: 3,
  /** The request is valid but the install is not in a state that allows it. */
  refused: 4,
} as const;

/** What a command needs from its process, so a test can run it without one. */
export interface CommandIo {
  env: NodeJS.ProcessEnv;
  /** The arguments after the command name. Only flags: `--stdin`. Never a secret. */
  args: readonly string[];
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Writes one JSON line and returns the exit code, so a command can `return finish(...)`. */
export function finish(io: CommandIo, code: number, body: Record<string, unknown>): number {
  const line = `${JSON.stringify(body)}\n`;
  if (code === EXIT.ok) io.stdout(line);
  else io.stderr(line);
  return code;
}
