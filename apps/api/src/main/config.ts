import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Environment contract of the API and worker processes.
 * Secrets (such as the database URL) come only from the environment, never from code or defaults.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DEPLOYMENT_MODE: z.enum(['multi', 'single']).default('multi'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly databaseUrl: string;
  readonly deploymentMode: 'multi' | 'single';
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly host: string;
  readonly port: number;
}

/** Raised when the environment is invalid. The message names variables, never their values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Only the variable name and the validation message are reported. Input values are
    // deliberately left out because they may be secrets.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration. ${problems}`);
  }
  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    deploymentMode: value.DEPLOYMENT_MODE,
    logLevel: value.LOG_LEVEL,
    host: value.HOST,
    port: value.PORT,
  };
}
