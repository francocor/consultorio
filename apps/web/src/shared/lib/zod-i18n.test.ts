import { LoginRequest } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { installZodMessages } from './zod-i18n.js';

installZodMessages();

function firstMessage(schema: z.ZodType, value: unknown): string | undefined {
  const result = schema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe('zod messages are translation keys, never English text', () => {
  it('maps a missing or empty value to "required"', () => {
    expect(firstMessage(z.string().min(1), '')).toBe('validation.required');
    expect(firstMessage(z.string(), undefined)).toBe('validation.required');
  });

  it('maps format, length and range failures to their own keys', () => {
    expect(firstMessage(z.email(), 'no-es-correo')).toBe('validation.email');
    expect(firstMessage(z.string().min(5), 'abc')).toBe('validation.too_short');
    expect(firstMessage(z.string().max(3), 'abcdef')).toBe('validation.too_long');
    expect(firstMessage(z.string().regex(/^\d+$/), 'abc')).toBe('validation.format');
    expect(firstMessage(z.number().min(1), 0)).toBe('validation.too_small');
  });

  it('applies to the shared contracts without touching them', () => {
    const result = LoginRequest.safeParse({ email: 'nope', password: '' });

    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toContain('validation.email');
    expect(messages).toContain('validation.required');
  });

  it('keeps a message the schema wrote on purpose', () => {
    expect(firstMessage(z.string().min(3, 'country.ar.national_id.invalid'), 'ab')).toBe(
      'country.ar.national_id.invalid',
    );
  });
});
