import type { Money } from '@consultorio/contracts';
import { useState, type ChangeEvent, type ComponentProps } from 'react';

import { cn } from '../lib/cn.js';
import { formatMoney, parseMoney } from '../lib/format.js';

import { Input } from './input.js';

/** The amount without the peso sign, which the field shows apart: `1.234,50`. */
const plain = (amount: Money) => formatMoney(amount).replace('$ ', '');

/** Only what can be part of an amount in es-AR: digits, the thousands dot, the decimal comma, a sign. */
const NOT_AN_AMOUNT_CHARACTER = /[^0-9.,-]/g;

export interface MoneyInputProps extends Omit<
  ComponentProps<'input'>,
  'value' | 'onChange' | 'type' | 'inputMode' | 'max' | 'min'
> {
  /** Whole cents of ARS, or `null` while the field is empty or does not hold an amount yet. */
  value: Money | null;
  /** Called as the person types: the amount, or `null` when the text is not (yet) one. */
  onValueChange: (value: Money | null) => void;
  /** A refund or a difference at the cash register can be negative; a price or a payment cannot. */
  allowNegative?: boolean;
  /** The largest amount accepted (inclusive), for example what is still owed. */
  max?: Money;
}

/**
 * An amount field. The person types it the Argentine way (`1.234,50`) and the form receives whole
 * cents (`Money`), never a float. Text that is not an amount, a negative where it is not allowed
 * and an amount above `max` all report `null`: the form decides what an empty or wrong field
 * means. The field is marked wrong only when the person leaves it, so typing is never scolded
 * halfway; what was typed stays as it is to be corrected, and only a valid amount is rewritten in
 * full (`1234,5` becomes `1.234,50`). Pair it with a `Label` through `id`.
 */
export function MoneyInput({
  value,
  onValueChange,
  allowNegative = false,
  max,
  className,
  onBlur,
  'aria-invalid': ariaInvalid,
  ...props
}: MoneyInputProps) {
  const read = (text: string): Money | null => {
    const amount = parseMoney(text);
    if (amount === null) return null;
    if (amount < 0 && !allowNegative) return null;
    if (max !== undefined && amount > max) return null;
    return amount;
  };

  const [text, setText] = useState(() => (value === null ? '' : plain(value)));
  const [reported, setReported] = useState<Money | null>(value);
  const [left, setLeft] = useState(false);

  // A value that changes from outside (a reset, another record) replaces the text. A value that
  // is only the echo of what was just typed does not touch it.
  if (value !== reported) {
    setReported(value);
    if (read(text) !== value) setText(value === null ? '' : plain(value));
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value.replace(NOT_AN_AMOUNT_CHARACTER, '');
    const amount = read(next);
    setText(next);
    setReported(amount);
    onValueChange(amount);
  };

  const wrong = left && text.trim() !== '' && read(text) === null;

  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground"
      >
        $
      </span>
      <Input
        {...props}
        value={text}
        onChange={handleChange}
        onBlur={(event) => {
          setLeft(true);
          const amount = read(text);
          if (amount !== null) setText(plain(amount));
          onBlur?.(event);
        }}
        inputMode="decimal"
        autoComplete="off"
        aria-invalid={wrong || ariaInvalid === true || ariaInvalid === 'true' ? true : undefined}
        className={cn('pl-7 text-right tabular-nums', className)}
      />
    </div>
  );
}
