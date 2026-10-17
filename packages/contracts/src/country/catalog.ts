/** A national holiday. `kind` separates statutory days from bridge days declared by decree. */
export interface Holiday {
  country: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  name: string;
  kind: 'national' | 'bridge';
}

export const PAYER_KINDS = ['obra_social', 'prepaga', 'private'] as const;
export type PayerKind = (typeof PAYER_KINDS)[number];

/** One entry of the platform payer catalog (obras sociales, prepagas and self-pay). */
export interface PayerSeed {
  country: string;
  code: string;
  name: string;
  kind: PayerKind;
}
