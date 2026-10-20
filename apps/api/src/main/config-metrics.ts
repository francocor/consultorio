import { z } from 'zod';

/**
 * Where a process exposes its metrics (`platform/metrics-server.ts`). Present in the configuration only
 * when `METRICS_PORT` is set: nothing listens by default.
 */
export interface MetricsConfig {
  readonly host: string;
  readonly port: number;
  /** The bearer token the scraper must send. Required as soon as the port is not on the loopback interface. */
  readonly token?: string;
}

/** The variables of the metrics port. They are documented in `docs/dev-setup.md` (a test checks it). */
export const METRICS_ENV_VARIABLES = ['METRICS_PORT', 'METRICS_HOST', 'METRICS_TOKEN'] as const;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

const metricsEnv = z.object({
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  METRICS_HOST: z
    .string()
    .refine(
      (host) => HOSTNAME.test(host) || IPV4.test(host) || (host.includes(':') && IPV6.test(host)),
      {
        message: 'must be a host name or an IP address',
      },
    )
    .default('127.0.0.1'),
  METRICS_TOKEN: z.string().min(24).max(200).optional(),
});

export type MetricsEnvProblem = { path: string; message: string };

/** True for the addresses that only the machine itself can reach. */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Reads the metrics settings. A port that anybody on the network can reach answers only to a token, so
 * the process refuses to start without one instead of exposing its counts to everyone. The problems
 * carry variable names and messages, never values.
 */
export function readMetricsConfig(env: NodeJS.ProcessEnv): {
  config?: MetricsConfig;
  problems: MetricsEnvProblem[];
} {
  const parsed = metricsEnv.safeParse(env);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    };
  }
  const { METRICS_PORT: port, METRICS_HOST: host, METRICS_TOKEN: token } = parsed.data;
  if (port === undefined) return { problems: [] };
  if (!isLoopback(host) && token === undefined) {
    return {
      problems: [
        {
          path: 'METRICS_TOKEN',
          message: 'is required when METRICS_HOST is reachable from outside the machine',
        },
      ],
    };
  }
  return { config: { host, port, ...(token === undefined ? {} : { token }) }, problems: [] };
}
