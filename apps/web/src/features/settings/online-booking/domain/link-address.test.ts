import { describe, expect, it } from 'vitest';

import { addressOf } from './link-address.js';

describe('addressOf', () => {
  it('joins the origin of the organization and the path of the link', () => {
    expect(addressOf('https://aillu.consultorio.test', '/book/abc12345')).toBe(
      'https://aillu.consultorio.test/book/abc12345',
    );
  });

  it('does not double the slash when the origin ends with one', () => {
    expect(addressOf('https://aillu.consultorio.test/', '/book/abc12345/p/def')).toBe(
      'https://aillu.consultorio.test/book/abc12345/p/def',
    );
  });

  it('has no address for a link whose path is not known yet', () => {
    expect(addressOf('https://aillu.consultorio.test', null)).toBeNull();
  });
});
