import { z } from 'zod';

/**
 * Money, the one way the product counts it (billing-payments, "Money is exact").
 *
 * An amount is a whole number of CENTS of Argentine pesos (ARS). There is no float anywhere: a
 * float cannot hold 0.10 and ends in "a cent is missing" at the cash register. The type is branded,
 * so a bare `number` cannot be passed where money is expected without going through `money()` (or
 * the schema), and the API, the worker and the web app all use this file, so they round the same.
 *
 * Rounding rules, in one place:
 * - a PERCENTAGE of an amount (`applyBasisPoints`) rounds half away from zero, so a credit and a
 *   debit of the same size round to the same size;
 * - a SPLIT of an amount by weights (`allocateProportional`) uses the largest remainder method and
 *   gives a tie to the EARLIEST line, so the parts always add up to the total, are never negative
 *   and the same input always gives the same answer.
 */

/** Whole cents of ARS. Signed: a refund, a difference at the cash register or a credit is negative. */
export const Money = z.int().brand<'MoneyCents'>();
export type Money = z.infer<typeof Money>;

/** Prices, charges, payments: an amount that cannot be below zero. */
export const NonNegativeMoney = z.int().min(0).brand<'MoneyCents'>();
export type NonNegativeMoney = z.infer<typeof NonNegativeMoney>;

export const MONEY_ZERO = 0 as Money;

/** Builds an amount from a number of cents. Anything but a safe integer is a bug, not an amount. */
export function money(cents: number): Money {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError('Money is a whole number of cents.');
  }
  // `-0` would print as "0" but fail `Object.is`; normalize it so equality is never surprising.
  return (cents === 0 ? 0 : cents) as Money;
}

export function isMoney(value: unknown): value is Money {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function addMoney(a: Money, b: Money): Money {
  return money(a + b);
}

export function subtractMoney(a: Money, b: Money): Money {
  return money(a - b);
}

export function negateMoney(amount: Money): Money {
  return money(0 - amount);
}

export function sumMoney(amounts: readonly Money[]): Money {
  let total = MONEY_ZERO;
  for (const amount of amounts) total = addMoney(total, amount);
  return total;
}

/** Rounds a quotient of two integers (denominator above zero) half away from zero. */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const doubledRemainder = (magnitude % denominator) * 2n;
  const rounded = doubledRemainder >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * A percentage of an amount. The rate is in basis points (1% = 100, 21% = 2100) so it is an
 * integer too. Rounds half away from zero. The product is computed with big integers, so a large
 * amount does not lose a cent to the 53 bits of a double.
 */
export function applyBasisPoints(amount: Money, basisPoints: number): Money {
  if (!Number.isSafeInteger(basisPoints)) {
    throw new RangeError('A rate is a whole number of basis points.');
  }
  const product = BigInt(amount) * BigInt(basisPoints);
  return money(Number(divideRounded(product, 10_000n)));
}

/**
 * Splits `total` over lines in proportion to `weights` (for example a discount over charge lines,
 * or a payment over the lines it settles).
 *
 * Largest remainder: every line first gets the whole cents of its quota; the cents left over go,
 * one each, to the lines with the largest fractional remainders, and a tie goes to the earliest
 * line. The parts always add up to the total and are never negative. A total of zero gives zero to
 * every line. Weights that add up to zero cannot receive a positive total.
 */
export function allocateProportional(total: Money, weights: readonly number[]): Money[] {
  if (total < 0) throw new RangeError('Only a non negative amount can be split.');
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError('A weight is a whole number, zero or more.');
    }
  }
  if (weights.length === 0) return [];
  if (total === 0) return weights.map(() => MONEY_ZERO);

  const weightSum = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (weightSum === 0n) throw new RangeError('The weights add up to zero.');

  const totalBig = BigInt(total);
  const shares = weights.map((weight, index) => {
    const scaled = totalBig * BigInt(weight);
    return { index, whole: scaled / weightSum, remainder: scaled % weightSum };
  });

  let leftover = Number(totalBig - shares.reduce((sum, share) => sum + share.whole, 0n));
  const byRemainder = [...shares].sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });
  const extra = new Set<number>();
  for (const share of byRemainder) {
    if (leftover === 0) break;
    extra.add(share.index);
    leftover -= 1;
  }

  return shares.map((share) => money(Number(share.whole) + (extra.has(share.index) ? 1 : 0)));
}

const CENTS_PER_PESO = 100;

/** `$ 1.234,50`; a negative amount is `-$ 90,00`. The same text on the server and in the browser. */
export function formatArs(amount: Money): string {
  const sign = amount < 0 ? '-' : '';
  const absolute = Math.abs(amount);
  const pesos = Math.trunc(absolute / CENTS_PER_PESO)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cents = (absolute % CENTS_PER_PESO).toString().padStart(2, '0');
  return `${sign}$ ${pesos},${cents}`;
}

/** An integer part in Argentine notation: plain digits, or groups of three joined by dots. */
const ARS_NUMBER = /^(\d+|\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/;

/**
 * Reads what a person types into an amount field: `1.234,50`, `$ 1.234,50`, `1234,5`, `35.000`,
 * `-90`. The dot is the thousands separator and the comma the decimal one, as in es-AR, so
 * `1234.5` and `1.23` are refused rather than guessed (they could mean two different amounts).
 * Returns `null` for anything else, including an amount beyond the safe integers.
 */
export function parseArs(text: string): Money | null {
  let rest = text.trim();
  let negative = false;
  if (rest.startsWith('-')) {
    negative = true;
    rest = rest.slice(1).trimStart();
  }
  if (rest.startsWith('$')) rest = rest.slice(1).trimStart();
  if (rest.startsWith('-')) {
    // `$-90` is fine; `--90` and `-$-90` are not.
    if (negative) return null;
    negative = true;
    rest = rest.slice(1).trimStart();
  }

  const match = ARS_NUMBER.exec(rest);
  if (!match) return null;
  const pesos = match[1];
  if (pesos === undefined) return null;
  const centsText = (match[2] ?? '').padEnd(2, '0');
  const total =
    BigInt(pesos.replaceAll('.', '')) * 100n + BigInt(centsText === '' ? '0' : centsText);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return money(negative ? -Number(total) : Number(total));
}
