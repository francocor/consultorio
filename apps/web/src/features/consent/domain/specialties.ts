/**
 * The specialties a template can be filed under: the ones of the clinical templates of the product
 * and of the starters. The label of each is in `locales/es-AR/consent.json` (`specialty.<key>`).
 */
export const SPECIALTIES = [
  'general',
  'odontology',
  'physiotherapy',
  'nutrition',
  'psychology',
] as const;

export type Specialty = (typeof SPECIALTIES)[number];

export function isSpecialty(value: string | null): value is Specialty {
  return SPECIALTIES.some((key) => key === value);
}
