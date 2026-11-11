import type {
  AppointmentMode,
  AppointmentTypeDto,
  CreateAppointmentTypeRequest,
  UpdateAppointmentTypeRequest,
} from '@consultorio/contracts';

/** The form of an appointment type, as text (what the person typed). */
export interface TypeFormValues {
  name: string;
  description: string;
  durationMinutes: string;
  bufferMinutes: string;
  mode: AppointmentMode;
  requiresApproval: boolean;
  /** `#rrggbb`, or empty for no color. */
  color: string;
  /** Empty means every professional may offer it. */
  professionalIds: string[];
}

export type TypeFormField = 'name' | 'durationMinutes' | 'bufferMinutes' | 'color';

export type TypeValidation =
  | { ok: true; request: CreateAppointmentTypeRequest }
  | { ok: false; errors: Partial<Record<TypeFormField, string>> };

const MAX_MINUTES = 1440;
const COLOR = /^#[0-9a-fA-F]{6}$/;

function wholeNumber(text: string): number | null {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
}

/**
 * Checks the form with the same rules as the API (a duration above zero, a buffer of zero or more,
 * a color as #rrggbb) so a mistake is explained beside the field instead of after a round trip.
 * Error values are keys of `scheduling:settings.types.errors`.
 */
export function validateType(values: TypeFormValues): TypeValidation {
  const errors: Partial<Record<TypeFormField, string>> = {};
  const name = values.name.trim();
  const duration = wholeNumber(values.durationMinutes);
  const buffer = wholeNumber(values.bufferMinutes);
  const color = values.color.trim();

  if (name === '' || name.length > 80) errors.name = 'name';
  if (duration === null || duration < 1 || duration > MAX_MINUTES)
    errors.durationMinutes = 'duration';
  if (buffer === null || buffer > MAX_MINUTES) errors.bufferMinutes = 'buffer';
  if (color !== '' && !COLOR.test(color)) errors.color = 'color';
  if (Object.keys(errors).length > 0 || duration === null || buffer === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    request: {
      name,
      description: values.description.trim() === '' ? null : values.description.trim(),
      durationMinutes: duration,
      bufferMinutes: buffer,
      mode: values.mode,
      requiresApproval: values.requiresApproval,
      color: color === '' ? null : color,
      professionalIds: values.professionalIds,
      specialties: [],
    },
  };
}

export function typeToForm(type: AppointmentTypeDto): TypeFormValues {
  return {
    name: type.name,
    description: type.description ?? '',
    durationMinutes: String(type.durationMinutes),
    bufferMinutes: String(type.bufferMinutes),
    mode: type.mode,
    requiresApproval: type.requiresApproval,
    color: type.color ?? '',
    professionalIds: type.professionalIds,
  };
}

/**
 * The fields of an edit that really changed. The price reference and the disciplines are not in
 * the form, so they are never sent and never overwritten.
 */
export function diffType(
  existing: AppointmentTypeDto,
  next: CreateAppointmentTypeRequest,
): UpdateAppointmentTypeRequest {
  const patch: UpdateAppointmentTypeRequest = {};
  if (next.name !== existing.name) patch.name = next.name;
  if (next.description !== existing.description) patch.description = next.description;
  if (next.durationMinutes !== existing.durationMinutes)
    patch.durationMinutes = next.durationMinutes;
  if (next.bufferMinutes !== existing.bufferMinutes) patch.bufferMinutes = next.bufferMinutes;
  if (next.mode !== existing.mode) patch.mode = next.mode;
  if (next.requiresApproval !== existing.requiresApproval) {
    patch.requiresApproval = next.requiresApproval;
  }
  if (next.color !== existing.color) patch.color = next.color;
  const sameProfessionals =
    next.professionalIds.length === existing.professionalIds.length &&
    next.professionalIds.every((id) => existing.professionalIds.includes(id));
  if (!sameProfessionals) patch.professionalIds = next.professionalIds;
  return patch;
}
