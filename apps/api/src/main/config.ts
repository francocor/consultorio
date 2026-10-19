import { z } from 'zod';

import { JOB_LOCAL_CONCURRENCY } from '../platform/jobs/concurrency.js';

import { readProviderConfig, type ProviderConfig } from './config-providers.js';
import { readScannerConfig, type ScannerConfig } from './config-scanner.js';
import { parseTrustProxy, type TrustProxySetting } from './trust-proxy.js';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** 2 to 63 characters, lowercase letters, digits and inner hyphens: safe as a DNS label. */
const TENANT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const KEK_BYTES = 32;
/**
 * The smallest runtime pool: an attempt to issue an invoice holds two connections (the transaction
 * that spans the call to the authority and the one of its mark), the worker runs
 * `JOB_LOCAL_CONCURRENCY` of them at once, and two more serve the sweeper and the other jobs.
 */
export const MIN_DB_POOL_MAX = 2 * JOB_LOCAL_CONCURRENCY + 2;
/** `name@host` or `Display Name <name@host>`. */
const MAIL_FROM_PATTERN = /^(?:[^<>\r\n]+ <[^\s<>@]+@[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+)$/;

/** The origin of an http(s) URL without credentials, or null. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    const http = url.protocol === 'https:' || url.protocol === 'http:';
    return http && url.username === '' && url.password === '' ? url.origin : null;
  } catch {
    return null;
  }
}

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
    /**
     * The most connections the runtime pool opens (default 10). An attempt to issue an invoice holds
     * one for the whole call to the authority and asks for a second one for its mark, so the pool is
     * sized for the attempts the worker runs at once (docs/runbooks/afip-switch-to-real.md). At least
     * `MIN_DB_POOL_MAX`: with fewer, two attempts each hold one connection and wait for the other's
     * (JD-S4 R4-B-T5).
     */
    DB_POOL_MAX: z.coerce
      .number()
      .int()
      .min(MIN_DB_POOL_MAX, {
        message: `must be at least ${String(MIN_DB_POOL_MAX)}: each of the ${String(JOB_LOCAL_CONCURRENCY)} attempts to issue an invoice that run at once holds 2 connections, and 2 more serve the sweeper and the other jobs`,
      })
      .max(100)
      .default(10),
    /**
     * The login of the platform operator console (role `app_operator`). Without it the console
     * does not exist: every `/operator/*` path answers 404. Multi-tenant mode only.
     */
    OPERATOR_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    /**
     * The login of the audit sealer (role `audit_sealer`): the only role that may fill the hash
     * chain of the audit trails. Only the worker process needs it, and the worker refuses to start
     * without it. The API process should not have it.
     */
    AUDIT_SEALER_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    DEPLOYMENT_MODE: z.enum(['multi', 'single']).default('multi'),
    /** multi mode: tenants live at `{slug}.BASE_DOMAIN`. Host name only: no scheme, port or path. */
    BASE_DOMAIN: z.string().regex(HOSTNAME).optional(),
    /** multi mode: the host that serves the platform operator console. */
    PLATFORM_HOST: z.string().regex(HOSTNAME).optional(),
    /** single mode: the one organization this deployment serves. */
    SINGLE_TENANT_SLUG: z.string().regex(TENANT_SLUG).optional(),
    /** Secure cookies. Defaults to true in production and false elsewhere (plain http locally). */
    COOKIE_SECURE: booleanFlag.optional(),
    /**
     * How many reverse proxies sit in front of the app (client addresses are read from
     * X-Forwarded-For that many hops from the right), or a list of proxy addresses and ranges, or
     * `false`. Default: 1 in production (one reverse proxy), `false` elsewhere. `true` is refused.
     */
    TRUST_PROXY: z.string().optional(),
    /**
     * Single mode: the origin the deployment is served from. Emailed links (password reset,
     * invitation) are built from it and never from the Host header of a request.
     */
    PUBLIC_URL: z.string().optional(),
    /** Multi mode, development only: the port the web app is served on, for emailed links. */
    PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    KMS_PROVIDER: z.enum(['local', 'aws']).default('local'),
    /** Development and tests only: 32 random bytes, base64. */
    KMS_LOCAL_KEK_BASE64: z.string().min(1).optional(),
    AWS_REGION: z.string().min(1).optional(),
    AWS_KMS_KEY_ID: z.string().min(1).optional(),
    /**
     * Object storage (logos now, documents later). MinIO locally (S3_ENDPOINT, static keys) or AWS
     * S3 in production (no endpoint; the task role supplies the credentials).
     */
    S3_BUCKET: z.string().min(3).max(63).optional(),
    S3_ENDPOINT: z.string().optional(),
    /** Defaults to AWS_REGION, then to us-east-1 (what MinIO expects). */
    S3_REGION: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: booleanFlag.optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** Transactional email over SMTP: Mailpit locally, the SES SMTP interface in production. */
    SMTP_HOST: z.string().regex(HOSTNAME).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_SECURITY: z.enum(['none', 'starttls', 'tls']).default('none'),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    MAIL_FROM: z.string().regex(MAIL_FROM_PATTERN).default('Consultorio <no-responder@localhost>'),
    /** Also check new passwords against a k-anonymity breach range API. Off by default. */
    AUTH_BREACH_CHECK: booleanFlag.default(false),
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
      require('PUBLIC_URL', 'is required when DEPLOYMENT_MODE is single');
    }

    if (env.PUBLIC_URL !== undefined) {
      const origin = originOf(env.PUBLIC_URL);
      if (origin === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_URL'],
          message: 'must be an http(s) origin without credentials, such as https://agenda.example',
        });
      } else if (env.NODE_ENV === 'production' && !origin.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_URL'],
          message: 'must be https in production',
        });
      }
    }

    if (env.TRUST_PROXY !== undefined) {
      const parsed = parseTrustProxy(env.TRUST_PROXY);
      if (!parsed.ok) {
        ctx.addIssue({ code: 'custom', path: ['TRUST_PROXY'], message: parsed.message });
      }
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

    if ((env.SMTP_USER === undefined) !== (env.SMTP_PASSWORD === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.SMTP_USER === undefined ? 'SMTP_USER' : 'SMTP_PASSWORD'],
        message: 'SMTP_USER and SMTP_PASSWORD must be set together',
      });
    }

    if (env.S3_BUCKET === undefined) {
      for (const name of [
        'S3_ENDPOINT',
        'S3_REGION',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
      ] as const) {
        if (env[name] !== undefined) require('S3_BUCKET', `is required when ${name} is set`);
      }
    }
    if (
      env.S3_ENDPOINT !== undefined &&
      !/^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(env.S3_ENDPOINT)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ENDPOINT'],
        message: 'must be an http(s) URL such as http://localhost:9000',
      });
    }
    if ((env.S3_ACCESS_KEY_ID === undefined) !== (env.S3_SECRET_ACCESS_KEY === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.S3_ACCESS_KEY_ID === undefined ? 'S3_SECRET_ACCESS_KEY' : 'S3_ACCESS_KEY_ID'],
        message: 'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together',
      });
    }

    if (env.NODE_ENV === 'production') {
      if (env.S3_ACCESS_KEY_ID !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['S3_ACCESS_KEY_ID'],
          message: 'static storage keys are not allowed in production; the task role is used',
        });
      }
      require('SMTP_HOST', 'is required in production (transactional email)');
      if (env.SMTP_HOST !== undefined && env.SMTP_SECURITY === 'none') {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_SECURITY'],
          message: 'the mail connection must use starttls or tls in production',
        });
      }
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

export interface StorageConfig {
  readonly bucket: string;
  readonly region: string;
  /** Set for MinIO or any S3-compatible service; unset for AWS S3. */
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  /** Only for local development; production uses the role of the task. */
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

export interface MailConfig {
  readonly host: string;
  readonly port: number;
  readonly security: 'none' | 'starttls' | 'tls';
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
}

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly databaseUrl: string;
  /** The most connections of the runtime pool (`DB_POOL_MAX`). */
  readonly dbPoolMax: number;
  /** Set when the operator console is enabled (multi-tenant mode and OPERATOR_DATABASE_URL). */
  readonly operatorDatabaseUrl?: string;
  /** Set for the worker: the `audit_sealer` login that seals and verifies the audit trails. */
  readonly auditSealerDatabaseUrl?: string;
  readonly deploymentMode: 'multi' | 'single';
  /** Set in multi mode. */
  readonly baseDomain?: string;
  /** Set in multi mode. */
  readonly platformHost?: string;
  /** Set in single mode. */
  readonly singleTenantSlug?: string;
  readonly cookieSecure: boolean;
  /** See `TrustProxySetting`: which hops of X-Forwarded-For are believed. */
  readonly trustProxy: TrustProxySetting;
  /** Single mode: the origin emailed links point at. */
  readonly publicUrl?: string;
  /** Multi mode, development: the web port in emailed links. */
  readonly publicPort?: number;
  readonly kms: KmsConfig;
  /** Undefined when S3_BUCKET is not set: logo upload and documents are then unavailable. */
  readonly storage?: StorageConfig;
  /** Undefined when CLAMAV_HOST is not set: development then scans with the fake scanner. */
  readonly scanner?: ScannerConfig;
  /** Undefined when SMTP_HOST is not set (allowed outside production). */
  readonly mail?: MailConfig;
  /** Which provider serves WhatsApp, video and the bot challenge (see config-providers.ts). */
  readonly providers: ProviderConfig;
  readonly passwordBreachCheck: boolean;
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

function trustProxyFrom(value: z.output<typeof envSchema>): TrustProxySetting {
  if (value.TRUST_PROXY === undefined) return value.NODE_ENV === 'production' ? 1 : false;
  const parsed = parseTrustProxy(value.TRUST_PROXY);
  // superRefine guarantees the value is valid.
  return parsed.ok ? parsed.value : false;
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
  // The scanner has its own small schema (see config-scanner.ts), read from the same environment.
  const scanner = readScannerConfig(withoutEmptyValues(env), {
    nodeEnv: value.NODE_ENV,
    storageConfigured: value.S3_BUCKET !== undefined,
  });
  if (scanner.problems.length > 0) {
    const problems = scanner.problems.map((problem) => `${problem.path}: ${problem.message}`);
    throw new ConfigError(`Invalid environment configuration. ${problems.join('; ')}`);
  }
  // The provider variables have their own small schema too; production refuses a simulator.
  const providers = readProviderConfig(withoutEmptyValues(env), { nodeEnv: value.NODE_ENV });
  if (providers.config === undefined) {
    const problems = providers.problems.map((problem) => `${problem.path}: ${problem.message}`);
    throw new ConfigError(`Invalid environment configuration. ${problems.join('; ')}`);
  }
  return {
    nodeEnv: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    dbPoolMax: value.DB_POOL_MAX,
    ...(value.AUDIT_SEALER_DATABASE_URL === undefined
      ? {}
      : { auditSealerDatabaseUrl: value.AUDIT_SEALER_DATABASE_URL }),
    ...(value.OPERATOR_DATABASE_URL === undefined || value.DEPLOYMENT_MODE === 'single'
      ? {}
      : { operatorDatabaseUrl: value.OPERATOR_DATABASE_URL }),
    deploymentMode: value.DEPLOYMENT_MODE,
    ...(value.BASE_DOMAIN === undefined ? {} : { baseDomain: value.BASE_DOMAIN }),
    ...(value.PLATFORM_HOST === undefined ? {} : { platformHost: value.PLATFORM_HOST }),
    ...(value.SINGLE_TENANT_SLUG === undefined
      ? {}
      : { singleTenantSlug: value.SINGLE_TENANT_SLUG }),
    cookieSecure: value.COOKIE_SECURE ?? value.NODE_ENV === 'production',
    trustProxy: trustProxyFrom(value),
    ...(value.PUBLIC_URL === undefined ? {} : { publicUrl: originOf(value.PUBLIC_URL) ?? '' }),
    ...(value.PUBLIC_PORT === undefined ? {} : { publicPort: value.PUBLIC_PORT }),
    kms: kmsFrom(value),
    ...(value.S3_BUCKET === undefined
      ? {}
      : {
          storage: {
            bucket: value.S3_BUCKET,
            region: value.S3_REGION ?? value.AWS_REGION ?? 'us-east-1',
            ...(value.S3_ENDPOINT === undefined ? {} : { endpoint: value.S3_ENDPOINT }),
            forcePathStyle: value.S3_FORCE_PATH_STYLE ?? value.S3_ENDPOINT !== undefined,
            ...(value.S3_ACCESS_KEY_ID === undefined || value.S3_SECRET_ACCESS_KEY === undefined
              ? {}
              : {
                  credentials: {
                    accessKeyId: value.S3_ACCESS_KEY_ID,
                    secretAccessKey: value.S3_SECRET_ACCESS_KEY,
                  },
                }),
          },
        }),
    ...(scanner.config === undefined ? {} : { scanner: scanner.config }),
    ...(value.SMTP_HOST === undefined
      ? {}
      : {
          mail: {
            host: value.SMTP_HOST,
            port: value.SMTP_PORT,
            security: value.SMTP_SECURITY,
            ...(value.SMTP_USER === undefined ? {} : { user: value.SMTP_USER }),
            ...(value.SMTP_PASSWORD === undefined ? {} : { password: value.SMTP_PASSWORD }),
            from: value.MAIL_FROM,
          },
        }),
    providers: providers.config,
    passwordBreachCheck: value.AUTH_BREACH_CHECK,
    lockout: {
      maxFailures: value.AUTH_LOCKOUT_MAX_FAILURES,
      lockMs: value.AUTH_LOCKOUT_MINUTES * 60_000,
    },
    logLevel: value.LOG_LEVEL,
    host: value.HOST,
    port: value.PORT,
  };
}
