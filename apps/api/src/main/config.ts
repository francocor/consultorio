import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** 2 to 63 characters, lowercase letters, digits and inner hyphens: safe as a DNS label. */
const TENANT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const KEK_BYTES = 32;

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Environment contract of the API and worker processes.
 * Secrets (such as the database URL and the local KEK) come only from the environment, never from
 * code or defaults. Cross-variable rules live in `superRefine` so a bad combination fails at
 * startup, naming the variables and never their values.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DEPLOYMENT_MODE: z.enum(['multi', 'single']).default('multi'),
    /** multi mode: tenants live at `{slug}.BASE_DOMAIN`. Host name only: no scheme, port or path. */
    BASE_DOMAIN: z.string().regex(HOSTNAME).optional(),
    /** multi mode: the host that serves the platform operator console. */
    PLATFORM_HOST: z.string().regex(HOSTNAME).optional(),
    /** single mode: the one organization this deployment serves. */
    SINGLE_TENANT_SLUG: z.string().regex(TENANT_SLUG).optional(),
    /** Secure cookies. Defaults to true in production and false elsewhere (plain http locally). */
    COOKIE_SECURE: booleanFlag.optional(),
    /** True behind a load balancer: client addresses are then read from X-Forwarded-For. */
    TRUST_PROXY: booleanFlag.default(false),
    KMS_PROVIDER: z.enum(['local', 'aws']).default('local'),
    /** Development and tests only: 32 random bytes, base64. */
    KMS_LOCAL_KEK_BASE64: z.string().min(1).optional(),
    AWS_REGION: z.string().min(1).optional(),
    AWS_KMS_KEY_ID: z.string().min(1).optional(),
    /** Consecutive failed sign-ins (wrong password or second-factor code) that lock an account. */
    AUTH_LOCKOUT_MAX_FAILURES: z.coerce.number().int().min(1).max(100).default(10),
    /** How long a locked account stays locked. */
    AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  })
  .superRefine((env, ctx) => {
    const require = (name: keyof typeof env, reason: string) => {
      if (env[name] === undefined) {
        ctx.addIssue({ code: 'custom', path: [name], message: reason });
      }
    };

    if (env.DEPLOYMENT_MODE === 'multi') {
      require('BASE_DOMAIN', 'is required when DEPLOYMENT_MODE is multi');
      require('PLATFORM_HOST', 'is required when DEPLOYMENT_MODE is multi');
    } else {
      require('SINGLE_TENANT_SLUG', 'is required when DEPLOYMENT_MODE is single');
    }

    if (env.KMS_PROVIDER === 'aws') {
      require('AWS_REGION', 'is required when KMS_PROVIDER is aws');
      require('AWS_KMS_KEY_ID', 'is required when KMS_PROVIDER is aws');
    } else {
      require('KMS_LOCAL_KEK_BASE64', 'is required when KMS_PROVIDER is local');
      if (
        env.KMS_LOCAL_KEK_BASE64 !== undefined &&
        Buffer.from(env.KMS_LOCAL_KEK_BASE64, 'base64').length !== KEK_BYTES
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['KMS_LOCAL_KEK_BASE64'],
          message: `must be ${String(KEK_BYTES)} bytes encoded as base64`,
        });
      }
    }

    if (env.NODE_ENV === 'production') {
      if (env.KMS_PROVIDER === 'local') {
        ctx.addIssue({
          code: 'custom',
          path: ['KMS_PROVIDER'],
          message: 'the local key-encryption key is not allowed in production',
        });
      }
      if (env.COOKIE_SECURE === false) {
        ctx.addIssue({
          code: 'custom',
          path: ['COOKIE_SECURE'],
          message: 'cookies must be secure in production',
        });
      }
    }
  });

/** Names of every variable the application reads. `.env.example` must document each of them. */
export const ENV_VARIABLES: readonly string[] = Object.keys(envSchema.shape);

export type KmsConfig =
  | { readonly provider: 'local'; readonly kekBase64: string }
  | { readonly provider: 'aws'; readonly region: string; readonly keyId: string };

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly databaseUrl: string;
  readonly deploymentMode: 'multi' | 'single';
  /** Set in multi mode. */
  readonly baseDomain?: string;
  /** Set in multi mode. */
  readonly platformHost?: string;
  /** Set in single mode. */
  readonly singleTenantSlug?: string;
  readonly cookieSecure: boolean;
  readonly trustProxy: boolean;
  readonly kms: KmsConfig;
  readonly lockout: { readonly maxFailures: number; readonly lockMs: number };
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

function kmsFrom(value: z.output<typeof envSchema>): KmsConfig {
  if (value.KMS_PROVIDER === 'aws') {
    // superRefine guarantees both are present.
    return { provider: 'aws', region: value.AWS_REGION ?? '', keyId: value.AWS_KMS_KEY_ID ?? '' };
  }
  return { provider: 'local', kekBase64: value.KMS_LOCAL_KEK_BASE64 ?? '' };
}

/** An empty variable (`NAME=` in an env file) means "not set". */
function withoutEmptyValues(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(withoutEmptyValues(env));
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
    ...(value.BASE_DOMAIN === undefined ? {} : { baseDomain: value.BASE_DOMAIN }),
    ...(value.PLATFORM_HOST === undefined ? {} : { platformHost: value.PLATFORM_HOST }),
    ...(value.SINGLE_TENANT_SLUG === undefined
      ? {}
      : { singleTenantSlug: value.SINGLE_TENANT_SLUG }),
    cookieSecure: value.COOKIE_SECURE ?? value.NODE_ENV === 'production',
    trustProxy: value.TRUST_PROXY,
    kms: kmsFrom(value),
    lockout: {
      maxFailures: value.AUTH_LOCKOUT_MAX_FAILURES,
      lockMs: value.AUTH_LOCKOUT_MINUTES * 60_000,
    },
    logLevel: value.LOG_LEVEL,
    host: value.HOST,
    port: value.PORT,
  };
}
