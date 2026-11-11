import type { AuditActor } from '../../../platform/audit/writer.js';

/** The system acts: there is no person, session or address behind a job or a notice of the provider. */
export const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

export const DAY_MS = 86_400_000;

/** Postgres error codes the module tells apart. */
export const UNIQUE_VIOLATION = '23505';

export function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function constraintOf(error: unknown): string | undefined {
  const cause = (error as { cause?: { constraint?: unknown } } | null)?.cause;
  const constraint = cause?.constraint ?? (error as { constraint?: unknown } | null)?.constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

export const addDays = (from: Date, days: number): Date => new Date(from.getTime() + days * DAY_MS);
