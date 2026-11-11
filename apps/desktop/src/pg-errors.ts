/**
 * What the shell may write to its log from the standard error of `pg_restore` and `pg_dump`.
 *
 * Those programs print the data they fail on: `CONTEXT:  COPY patient, line 3: "<the row>"`, `DETAIL:  Key
 * (dni)=(...) already exists`, `Command was: INSERT INTO ... VALUES (...)`, and the error text itself often quotes
 * the value that did not fit. The log is plain text on a shared PC, so only the line that says WHAT failed is kept,
 * with the values it quotes and anything after `line N:` taken out.
 */
const MAX_LENGTH = 300;

export function summarizePgError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const first = lines.find((line) => /^pg_(?:restore|dump): error:/.test(line)) ?? lines[0] ?? '';
  return first
    .replace(/\bline (\d+):.*$/, 'line $1')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .slice(0, MAX_LENGTH);
}
