import { describe, expect, it } from 'vitest';

import { redact } from './redact.js';

describe('what shell.log must not keep', () => {
  it('hides the password of a connection address and keeps the rest', () => {
    const text = 'connect postgres://app_rw:s3cr3t%2Fkey@127.0.0.1:54321/consultorio failed';

    const result = redact(text);

    expect(result).toBe('connect postgres://app_rw:***@127.0.0.1:54321/consultorio failed');
    expect(result).not.toContain('s3cr3t');
  });

  it('hides an email address, which in a message of the API is a patient or a user', () => {
    expect(redact('error for ana.gomez@clinica.example while saving')).toBe(
      'error for [email] while saving',
    );
  });

  it('hides a password given as password=... or password: ...', () => {
    expect(redact('password=hunter2 rest')).toBe('password=*** rest');
    expect(redact('Password: hunter2 rest')).toBe('password=*** rest');
  });

  it('hides the values PostgreSQL quotes from a row in an error', () => {
    expect(redact('Key (document_number)=(20123456) already exists.')).toBe(
      'Key (document_number)=(***) already exists.',
    );
  });

  it('leaves ordinary lines alone: ports, paths, exit codes, file names', () => {
    const line =
      'api failed: exited (code 1) on port 41000, see C:\\Users\\Ana\\AppData\\Local\\Consulvia\\logs';

    expect(redact(line)).toBe(line);
    expect(redact('backup created: consulvia-20261024-100000.cvb')).toBe(
      'backup created: consulvia-20261024-100000.cvb',
    );
  });
});
