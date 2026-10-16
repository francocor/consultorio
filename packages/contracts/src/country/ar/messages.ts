/**
 * es-AR texts for the validation keys the Argentina validators return. The web locale files load
 * these, and the API only ever returns the keys.
 */
export const AR_VALIDATION_MESSAGES_ES_AR = {
  'country.ar.national_id.invalid': 'El DNI no es válido. Ingrese entre 6 y 8 dígitos.',
  'country.ar.passport.invalid':
    'El pasaporte no es válido. Ingrese entre 6 y 20 letras o números, sin símbolos.',
  'country.ar.tax_id.invalid':
    'El CUIT/CUIL no es válido. Revise los dígitos y el dígito verificador.',
  'country.ar.matricula.invalid': 'El número de matrícula no tiene un formato válido.',
  'country.ar.matricula.unknown_jurisdiction': 'La jurisdicción de la matrícula no es válida.',
} as const;

export type ArValidationMessageKey = keyof typeof AR_VALIDATION_MESSAGES_ES_AR;
