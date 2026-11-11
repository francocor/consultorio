import { LOCALE, formatNumber } from '../../../shared/lib/format.js';

const MISSING = '–';

const percent = new Intl.NumberFormat(LOCALE, {
  style: 'percent',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

/** A ratio the server sends in basis points (1200 is 12%): `12 %`, `33,3 %`; a dash when it is null. */
export function formatRate(basisPoints: number | null): string {
  return basisPoints === null ? MISSING : percent.format(basisPoints / 10_000);
}

/** Minutes as people say them: `1 h 30 min`, `4 h`, `45 min`. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${formatNumber(rest)} min`;
  return rest === 0
    ? `${formatNumber(hours)} h`
    : `${formatNumber(hours)} h ${formatNumber(rest)} min`;
}
