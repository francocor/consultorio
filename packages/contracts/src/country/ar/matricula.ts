import { fail, ok, type Result } from '../../result.js';

/** Identifier of the national registry. Provincial registries use ISO 3166-2:AR codes. */
const NATIONAL = 'NATIONAL';

/**
 * The 23 provinces plus the Autonomous City of Buenos Aires (ISO 3166-2:AR). The national
 * registry (matricula nacional) is `NATIONAL`.
 */
export const AR_JURISDICTIONS = {
  national: NATIONAL,
  provincial: [
    { code: 'AR-A', name: 'Salta' },
    { code: 'AR-B', name: 'Buenos Aires' },
    { code: 'AR-C', name: 'Ciudad Autónoma de Buenos Aires' },
    { code: 'AR-D', name: 'San Luis' },
    { code: 'AR-E', name: 'Entre Ríos' },
    { code: 'AR-F', name: 'La Rioja' },
    { code: 'AR-G', name: 'Santiago del Estero' },
    { code: 'AR-H', name: 'Chaco' },
    { code: 'AR-J', name: 'San Juan' },
    { code: 'AR-K', name: 'Catamarca' },
    { code: 'AR-L', name: 'La Pampa' },
    { code: 'AR-M', name: 'Mendoza' },
    { code: 'AR-N', name: 'Misiones' },
    { code: 'AR-P', name: 'Formosa' },
    { code: 'AR-Q', name: 'Neuquén' },
    { code: 'AR-R', name: 'Río Negro' },
    { code: 'AR-S', name: 'Santa Fe' },
    { code: 'AR-T', name: 'Tucumán' },
    { code: 'AR-U', name: 'Chubut' },
    { code: 'AR-V', name: 'Tierra del Fuego' },
    { code: 'AR-W', name: 'Corrientes' },
    { code: 'AR-X', name: 'Córdoba' },
    { code: 'AR-Y', name: 'Jujuy' },
    { code: 'AR-Z', name: 'Santa Cruz' },
  ],
} as const;

export interface Matricula {
  jurisdiction: string;
  /** Digits only. */
  number: string;
}

/**
 * Format of the number per registry type. This is plausibility only: it proves the text looks
 * like a registration number, never that the registration exists (verification is an operator
 * action, see staff-professionals). Every provincial registry shares one pattern for now; a
 * jurisdiction that needs its own pattern gets an entry in `JURISDICTION_NUMBER_PATTERN`.
 */
const NUMBER_PATTERN = {
  national: /^\d{1,6}$/,
  provincial: /^\d{1,7}$/,
};
const JURISDICTION_NUMBER_PATTERN: Readonly<Record<string, RegExp>> = {};

const PREFIX = /^(M\.?\s?N\.?|M\.?\s?P\.?)\s*(.*)$/;

/** Validates and normalizes a registration number typed as "MP 12.345", "M.N. 98765" or "12345". */
export function validateMatricula(jurisdiction: string, input: string): Result<Matricula> {
  const isNational = jurisdiction === NATIONAL;
  const isProvincial = AR_JURISDICTIONS.provincial.some(({ code }) => code === jurisdiction);
  if (!isNational && !isProvincial) {
    return fail('country.ar.matricula.unknown_jurisdiction');
  }

  const text = input.trim().toUpperCase();
  const prefixed = PREFIX.exec(text);
  let rest = text;
  if (prefixed) {
    const prefix = (prefixed[1] ?? '').replace(/[\s.]/g, '');
    // MN belongs to the national registry and MP to a provincial one.
    if ((prefix === 'MN') !== isNational) return fail('country.ar.matricula.invalid');
    rest = prefixed[2] ?? '';
  }

  const number = rest.replace(/[\s.]/g, '');
  const pattern =
    JURISDICTION_NUMBER_PATTERN[jurisdiction] ??
    NUMBER_PATTERN[isNational ? 'national' : 'provincial'];
  if (!pattern.test(number) || Number(number) === 0) {
    return fail('country.ar.matricula.invalid');
  }
  return ok({ jurisdiction, number });
}
