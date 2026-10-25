import { describe, expect, it } from 'vitest';

import { summarizePgError } from './pg-errors.js';

// What pg_restore really prints when a row does not load: the error, then the row itself under CONTEXT and,
// for a failed statement, the whole statement under "Command was".
const COPY_FAILURE = [
  'pg_restore: connecting to database for restore',
  'pg_restore: error: COPY failed for table "patient": ERROR:  invalid input syntax for type date: "12/03/1985"',
  'CONTEXT:  COPY patient, line 3, column birth_date: "12/03/1985"',
  'pg_restore: error: could not execute query: ERROR:  duplicate key value violates unique constraint "patient_dni_key"',
  'DETAIL:  Key (dni)=(30123456) already exists.',
  "Command was: INSERT INTO patient VALUES ('Ana Gómez', '30123456', 'ana@clinica.example');",
].join('\n');

describe('what is kept of an error of pg_restore or pg_dump', () => {
  it('is the first line that says what failed, and nothing of the rows around it', () => {
    const summary = summarizePgError(COPY_FAILURE);

    expect(summary).toContain('pg_restore: error: COPY failed for table');
    for (const leak of ['12/03/1985', 'Ana Gómez', '30123456', 'ana@clinica.example', 'CONTEXT']) {
      expect(summary, leak).not.toContain(leak);
    }
  });

  it('takes out the values the error quotes, because a value is data', () => {
    const summary = summarizePgError(
      'pg_restore: error: could not execute query: ERROR:  invalid input syntax for type integer: "Ana Gómez"',
    );

    expect(summary).not.toContain('Ana Gómez');
    expect(summary).toContain('invalid input syntax for type integer');
  });

  it('cuts what follows "line N:" in the lines that carry a row', () => {
    const summary = summarizePgError(
      'pg_restore: error: COPY failed for table "x": ERROR:  bad, line 4: "Ana\tGómez\t30123456"',
    );

    expect(summary).not.toContain('Gómez');
    expect(summary).toContain('line 4');
  });

  it('keeps a message that has no row in it, such as the program missing or a refused login', () => {
    expect(
      summarizePgError(
        'pg_restore: error: connection to server failed: FATAL:  password authentication failed',
      ),
    ).toContain('password authentication failed');
  });

  it('falls back to the first line when no line starts with the name of the program', () => {
    const summary = summarizePgError('something odd happened\nand then with a row: Ana Gómez');

    expect(summary).toBe('something odd happened');
  });

  it('is empty for an empty error and short for a long one', () => {
    expect(summarizePgError('')).toBe('');
    expect(summarizePgError(`pg_dump: error: ${'x'.repeat(5000)}`).length).toBeLessThanOrEqual(300);
  });
});
