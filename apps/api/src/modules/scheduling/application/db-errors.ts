const EXCLUSION_VIOLATION = '23P01';

/** The SQLSTATE of a database failure, whichever layer wrapped it. */
export function sqlStateOf(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  const direct = (error as { code?: unknown } | null)?.code;
  return typeof direct === 'string' ? direct : undefined;
}

/** The database refused an overlap (the exclusion constraint of the occupancy table). */
export function isExclusionViolation(error: unknown): boolean {
  return sqlStateOf(error) === EXCLUSION_VIOLATION;
}
