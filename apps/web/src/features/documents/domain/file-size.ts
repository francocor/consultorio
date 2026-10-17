import { LOCALE } from '../../../shared/lib/format.js';

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** `1,5 KB`, `20 MB`: one decimal at most, the comma of es-AR, binary units like a file manager. */
export function formatFileSize(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let value = safe;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = new Intl.NumberFormat(LOCALE, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
  return `${number} ${UNITS[unit] ?? 'B'}`;
}
