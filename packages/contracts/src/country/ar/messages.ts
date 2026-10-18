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
  // The rules of the AFIP invoice types (e-invoicing-afip), with the official terminology.
  'country.ar.invoice.type_forbidden':
    'Ese tipo de comprobante no corresponde según la condición frente al IVA del emisor y del receptor.',
  'country.ar.invoice.credit_note_of_credit_note':
    'Una nota de crédito no se cancela con otra nota de crédito. Emita una factura nueva si hace falta.',
  'country.ar.invoice.recipient_condition_invalid':
    'La Factura A solo se emite a un receptor responsable inscripto.',
  'country.ar.invoice.recipient_cuit_required':
    'La Factura A necesita el CUIT del receptor. Ingréselo para continuar.',
  'country.ar.invoice.recipient_identification_required':
    'Con este importe hay que identificar al receptor: ingrese su nombre y su DNI o CUIT.',
} as const;

export type ArValidationMessageKey = keyof typeof AR_VALIDATION_MESSAGES_ES_AR;
