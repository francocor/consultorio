import { money } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { closingDraft } from './closing.js';

describe('what the closing form knows about the count', () => {
  it('has no difference when the count matches what is expected (35.000 expected, 35.000 counted)', () => {
    const draft = closingDraft({ expected: money(3_500_000), counted: money(3_500_000) });

    expect(draft).toMatchObject({
      difference: 0,
      needsReason: false,
      canSubmit: true,
      kind: 'exact',
    });
  });

  it('reports cash missing as a negative difference that needs a reason', () => {
    const draft = closingDraft({ expected: money(3_500_000), counted: money(3_400_000) });

    expect(draft).toMatchObject({ difference: -100_000, needsReason: true, kind: 'short' });
  });

  it('reports a surplus as a positive difference that needs a reason too', () => {
    const draft = closingDraft({ expected: money(3_500_000), counted: money(3_650_000) });

    expect(draft).toMatchObject({ difference: 150_000, needsReason: true, kind: 'over' });
  });

  it('cannot be submitted without a count, and a difference also needs the reason to be written', () => {
    expect(closingDraft({ expected: money(100), counted: null }).canSubmit).toBe(false);
    expect(closingDraft({ expected: money(100), counted: money(50) }).canSubmit).toBe(false);
    expect(
      closingDraft({ expected: money(100), counted: money(50), reason: ' x ' }).canSubmit,
    ).toBe(false);
    expect(
      closingDraft({ expected: money(100), counted: money(50), reason: 'Falta un billete' })
        .canSubmit,
    ).toBe(true);
  });
});
