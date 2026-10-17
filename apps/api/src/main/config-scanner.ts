import { z } from 'zod';

/** Where `clamd` listens. Present in the configuration only when the deployment runs ClamAV. */
export interface ScannerConfig {
  readonly host: string;
  readonly port: number;
}

/** The variables of the scanner. They are documented in `docs/dev-setup.md` (a test checks it). */
export const SCANNER_ENV_VARIABLES = ['CLAMAV_HOST', 'CLAMAV_PORT'] as const;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const scannerEnv = z.object({
  CLAMAV_HOST: z.string().regex(HOSTNAME).optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
});

export type ScannerEnvProblem = { path: string; message: string };

/**
 * Reads the scanner settings. Outside production the scanner is optional (the fake one runs), but
 * production with a bucket must have ClamAV: with documents stored and no scanner, every upload
 * would wait in quarantine forever, so the process refuses to start instead. The problems carry
 * variable names and messages, never values.
 */
export function readScannerConfig(
  env: NodeJS.ProcessEnv,
  context: { nodeEnv: string; storageConfigured: boolean },
): { config?: ScannerConfig; problems: ScannerEnvProblem[] } {
  const parsed = scannerEnv.safeParse(env);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    };
  }
  const { CLAMAV_HOST: host, CLAMAV_PORT: port } = parsed.data;
  if (host === undefined) {
    // A port alone is not an error: the compose file also reads CLAMAV_PORT, to publish the container.
    if (context.nodeEnv === 'production' && context.storageConfigured) {
      return {
        problems: [
          {
            path: 'CLAMAV_HOST',
            message: 'is required in production when S3_BUCKET is set (every upload is scanned)',
          },
        ],
      };
    }
    return { problems: [] };
  }
  return { config: { host, port }, problems: [] };
}
