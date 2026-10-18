import { money, type Money } from '@consultorio/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../test/a11y.js';

import { Label } from './label.js';
import { MoneyInput } from './money-input.js';

function Harness({
  initial = null,
  onValueChange,
  ...rest
}: {
  initial?: Money | null;
  onValueChange?: (value: Money | null) => void;
  allowNegative?: boolean;
  max?: Money;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<Money | null>(initial);
  return (
    <div>
      <Label htmlFor="amount">Importe</Label>
      <MoneyInput
        id="amount"
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onValueChange?.(next);
        }}
        {...rest}
      />
      <output data-testid="cents">{value === null ? 'none' : String(value)}</output>
    </div>
  );
}

const field = () => screen.getByLabelText('Importe');

describe('MoneyInput (whole cents of ARS, typed the Argentine way)', () => {
  it('turns what is typed into cents as it is typed', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness onValueChange={seen} />);

    await user.type(field(), '1.234,5');

    expect(seen).toHaveBeenLastCalledWith(123_450);
    expect(screen.getByTestId('cents')).toHaveTextContent('123450');
  });

  it('writes the amount in full when the person leaves the field', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(field(), '1234,5');
    await user.tab();

    expect(field()).toHaveValue('1.234,50');
  });

  it('shows the value it is given, without the peso sign (a sign sits beside the field)', () => {
    render(<Harness initial={money(3_500_000)} />);

    expect(field()).toHaveValue('35.000,00');
  });

  it('follows a value that changes from outside, such as a form reset', async () => {
    const user = userEvent.setup();
    function Reset() {
      const [value, setValue] = useState<Money | null>(money(1_000));
      return (
        <div>
          <Label htmlFor="amount">Importe</Label>
          <MoneyInput id="amount" value={value} onValueChange={setValue} />
          <button
            type="button"
            onClick={() => {
              setValue(money(250_050));
            }}
          >
            Poner 2.500,50
          </button>
        </div>
      );
    }
    render(<Reset />);

    await user.click(screen.getByRole('button', { name: 'Poner 2.500,50' }));

    expect(field()).toHaveValue('2.500,50');
  });

  it('reports no amount for an empty field, and does not call an empty field wrong', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness initial={money(500)} onValueChange={seen} />);

    await user.clear(field());
    await user.tab();

    expect(seen).toHaveBeenLastCalledWith(null);
    expect(field()).not.toHaveAttribute('aria-invalid', 'true');
  });

  it.each(['12,345', '1.23', '1234.5', '1,2,3'])(
    'does not guess what %s means: no amount, and the field is marked wrong when left',
    async (typed) => {
      const user = userEvent.setup();
      const seen = vi.fn();
      render(<Harness onValueChange={seen} />);

      await user.type(field(), typed);
      expect(seen).toHaveBeenLastCalledWith(null);
      expect(field()).not.toHaveAttribute('aria-invalid', 'true');
      await user.tab();

      expect(field()).toHaveAttribute('aria-invalid', 'true');
      // What the person typed stays there to be corrected, never rewritten into something else.
      expect(field()).toHaveValue(typed);
    },
  );

  it('ignores letters and symbols that cannot be part of an amount', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(field(), '$ 12ab,50');

    expect(field()).toHaveValue('12,50');
  });

  it('refuses a negative amount unless the field says negatives are allowed', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.type(field(), '-90');
    await user.tab();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    unmount();

    const seen = vi.fn();
    render(<Harness allowNegative onValueChange={seen} />);
    await user.type(field(), '-90');
    await user.tab();

    expect(seen).toHaveBeenLastCalledWith(-9_000);
    expect(field()).not.toHaveAttribute('aria-invalid', 'true');
    expect(field()).toHaveValue('-90,00');
  });

  it('marks an amount above the maximum as wrong, and reports none', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness max={money(10_000)} onValueChange={seen} />);

    await user.type(field(), '100,01');
    await user.tab();

    expect(seen).toHaveBeenLastCalledWith(null);
    expect(field()).toHaveAttribute('aria-invalid', 'true');
  });

  it('opens the numeric keypad on a phone and is right aligned', () => {
    render(<Harness />);

    expect(field()).toHaveAttribute('inputmode', 'decimal');
    expect(field()).toHaveAttribute('autocomplete', 'off');
    expect(field().className).toContain('text-right');
  });

  it('can be disabled, and has no accessibility violations', async () => {
    const { container } = render(<Harness initial={money(100)} disabled />);

    expect(field()).toBeDisabled();
    expect(await a11yViolations(container)).toEqual([]);
  });
});
