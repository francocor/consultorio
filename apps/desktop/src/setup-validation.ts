import { checkPassword, PASSWORD_MESSAGES } from './password-check.js';

/** The organization of an install is always this one: nobody types an address, so there is nothing to choose. */
export const INSTALL_SLUG = 'consultorio';

export const DEFAULT_TIME_ZONE = 'America/Argentina/Buenos_Aires';

/** The zones the setup screen offers: Argentina first, then the neighbours. */
export const TIME_ZONES: readonly { id: string; label: string }[] = [
  { id: 'America/Argentina/Buenos_Aires', label: 'Argentina (Buenos Aires)' },
  { id: 'America/Argentina/Cordoba', label: 'Argentina (Córdoba)' },
  { id: 'America/Argentina/Salta', label: 'Argentina (Salta)' },
  { id: 'America/Argentina/Jujuy', label: 'Argentina (Jujuy)' },
  { id: 'America/Argentina/Tucuman', label: 'Argentina (Tucumán)' },
  { id: 'America/Argentina/Catamarca', label: 'Argentina (Catamarca)' },
  { id: 'America/Argentina/La_Rioja', label: 'Argentina (La Rioja)' },
  { id: 'America/Argentina/San_Juan', label: 'Argentina (San Juan)' },
  { id: 'America/Argentina/Mendoza', label: 'Argentina (Mendoza)' },
  { id: 'America/Argentina/San_Luis', label: 'Argentina (San Luis)' },
  { id: 'America/Argentina/Rio_Gallegos', label: 'Argentina (Río Gallegos)' },
  { id: 'America/Argentina/Ushuaia', label: 'Argentina (Ushuaia)' },
  { id: 'America/Montevideo', label: 'Uruguay (Montevideo)' },
  { id: 'America/Santiago', label: 'Chile (Santiago)' },
  { id: 'America/Asuncion', label: 'Paraguay (Asunción)' },
];

export interface SetupForm {
  organizationName: string;
  ownerName: string;
  ownerEmail: string;
  password: string;
  passwordConfirmation: string;
  timeZone: string;
}

export type SetupField = keyof SetupForm;
export type FieldErrors = Partial<Record<SetupField, string>>;

export interface SetupValues {
  organizationName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  timeZone: string;
}

/** Control, format and separator characters: a name ends up in emails and screens as one visible line. */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function checkName(value: string, min: number, max: number): boolean {
  const length = Array.from(value).length;
  return length >= min && length <= max && !HIDDEN_CHARACTER.test(value);
}

/**
 * Checks what the setup screen sent, field by field, in the words the owner reads. The API checks again
 * (`provision` answers `invalid_input` or `password_rejected`); this is so most mistakes are found before
 * anything is created.
 */
export function validateSetup(
  raw: unknown,
  common: ReadonlySet<string>,
): { ok: true; value: SetupValues } | { ok: false; errors: FieldErrors } {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const organizationName = text(input['organizationName']).trim();
  const ownerName = text(input['ownerName']).trim();
  const ownerEmail = text(input['ownerEmail']).trim().toLowerCase();
  const password = text(input['password']);
  const passwordConfirmation = text(input['passwordConfirmation']);
  const timeZone = text(input['timeZone']) || DEFAULT_TIME_ZONE;
  const errors: FieldErrors = {};

  if (!checkName(organizationName, 2, 80)) {
    errors.organizationName = 'Ingrese el nombre del consultorio (entre 2 y 80 caracteres).';
  }
  if (!checkName(ownerName, 2, 100)) {
    errors.ownerName = 'Ingrese su nombre completo (entre 2 y 100 caracteres).';
  }
  if (!EMAIL.test(ownerEmail) || ownerEmail.length > 254) {
    errors.ownerEmail = 'Ingrese un correo electrónico válido. Con él va a ingresar a Consulvia.';
  }
  if (!TIME_ZONES.some((zone) => zone.id === timeZone)) {
    errors.timeZone = 'Elija una zona horaria de la lista.';
  }
  if (password === '') {
    errors.password = 'Ingrese una contraseña.';
  } else {
    const [issue] = checkPassword(password, ownerEmail, common);
    if (issue !== undefined) errors.password = PASSWORD_MESSAGES[issue];
  }
  if (errors.password === undefined && password !== passwordConfirmation) {
    errors.passwordConfirmation = 'Las contraseñas no coinciden.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { organizationName, ownerName, ownerEmail, ownerPassword: password, timeZone },
  };
}

/** The same password rules for the form that resets the owner's password. */
export function validateNewPassword(
  password: unknown,
  confirmation: unknown,
  email: string,
  common: ReadonlySet<string>,
):
  | { ok: true; value: string }
  | { ok: false; errors: { password?: string; passwordConfirmation?: string } } {
  const value = text(password);
  if (value === '') return { ok: false, errors: { password: 'Ingrese la nueva contraseña.' } };
  const [issue] = checkPassword(value, email, common);
  if (issue !== undefined) return { ok: false, errors: { password: PASSWORD_MESSAGES[issue] } };
  if (value !== text(confirmation)) {
    return { ok: false, errors: { passwordConfirmation: 'Las contraseñas no coinciden.' } };
  }
  return { ok: true, value };
}
