import { describe, expect, it } from 'vitest';

import { csvCell, csvRow } from './csv.js';

describe('csvCell', () => {
  it('leaves plain text alone and writes null and undefined as empty', () => {
    expect(csvCell('patient.read')).toBe('patient.read');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('writes numbers and booleans as text', () => {
    expect(csvCell(12)).toBe('12');
    expect(csvCell(false)).toBe('false');
  });

  it.each([
    ['a comma', 'a,b', '"a,b"'],
    ['a line break', 'a\nb', '"a\nb"'],
    ['a carriage return', 'a\rb', '"a\rb"'],
    ['a quote, which is doubled', 'say "hi"', '"say ""hi"""'],
  ])('quotes a cell with %s', (_name, input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1'])(
    'defuses %j, which a spreadsheet would run as a formula',
    (input) => {
      const cell = csvCell(input);

      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('defuses a formula that also needs quoting', () => {
    expect(csvCell('=HYPERLINK("http://evil.example","x")')).toBe(
      `"'=HYPERLINK(""http://evil.example"",""x"")"`,
    );
  });

  it('does not touch a dash or equals sign in the middle of a cell', () => {
    expect(csvCell('a-b=c')).toBe('a-b=c');
    expect(csvCell('2026-10-16T09:00:00Z')).toBe('2026-10-16T09:00:00Z');
  });
});

describe('csvRow', () => {
  it('joins cells with commas and ends with a CRLF', () => {
    expect(csvRow(['a', null, 'b,c'])).toBe('a,,"b,c"\r\n');
  });
});
