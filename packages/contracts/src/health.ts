import { z } from 'zod';

/** Status values reported by the liveness and readiness probes. */
export const HealthStatus = z.enum(['ok', 'unavailable']);
export type HealthStatus = z.infer<typeof HealthStatus>;

/** Body returned by `/health` and `/ready`. */
export const HealthResponse = z.object({
  status: HealthStatus,
});
export type HealthResponse = z.infer<typeof HealthResponse>;
