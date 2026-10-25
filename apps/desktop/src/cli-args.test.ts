import { describe, expect, it } from 'vitest';

import { parseArgs } from './cli-args.js';

describe('what a launch of the program asks for', () => {
  const file = ['Copias', 'consulvia-2026-10-24_1000.zip'].join('/');

  it('shows the window by default', () => {
    expect(parseArgs([])).toEqual({ request: { kind: 'show' }, hidden: false });
    expect(parseArgs(['--unknown'])).toEqual({ request: { kind: 'show' }, hidden: false });
  });

  it('can ask to quit, to back up, or to restore a file', () => {
    expect(parseArgs(['--quit']).request).toEqual({ kind: 'quit' });
    expect(parseArgs(['--backup']).request).toEqual({ kind: 'backup' });
    expect(parseArgs(['--reset-password']).request).toEqual({ kind: 'reset-password' });
    expect(parseArgs(['--restore=' + file]).request).toEqual({ kind: 'restore', file });
  });

  it('ignores a restore without a file', () => {
    expect(parseArgs(['--restore=']).request).toEqual({ kind: 'show' });
  });

  it('starts hidden at the login of Windows', () => {
    expect(parseArgs(['--hidden'])).toEqual({ request: { kind: 'show' }, hidden: true });
  });
});
