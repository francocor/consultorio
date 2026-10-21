import { z } from 'zod';

import { releaserPublicKeyOf } from '../modules/tenancy/archive/archive-crypto.js';
import {
  checkLocalProviders,
  type NodeEnvironment,
  type ProviderSelection,
} from '../platform/local-providers/guard.js';

/**
 * The provider variables of the patient-engagement stages. They are documented in
 * `docs/dev-setup.md` (a test checks it). Every later stage that adds a provider adds its
 * variables here, so the shared `config.ts` stays untouched. `AFIP_PROVIDER` (Stage 4) is the
 * electronic-invoicing issuer: the local simulator, the real ARCA adapter (deferred) or none.
 * `ERX_PROVIDER` (Stage 5) is the e-prescription platform: the local simulator or none; the key of
 * the real provider is added with its adapter (task 5.53). `PAYMENTS_PROVIDER` (Stage 6) is the
 * payments gateway of the platform subscriptions: the local Mercado Pago simulator or none; the key
 * of the real gateway is added with its adapter (task 6.50). `MP_WEBHOOK_SECRET` signs its
 * webhook and `MP_PUBLIC_BASE_URL` is the address the hosted checkout and the webhook are reached on.
 * The `ARCHIVE_*` variables (Stage 6, retention) describe the archive of cancelled organizations: its
 * write-once bucket, how long it is kept, how long after the cancellation it is written, and the key
 * of the releaser. `ARCHIVE_RELEASER_KEK` belongs to the `releaser` process alone: the API and the
 * worker refuse to start with it.
 */
export const PROVIDER_ENV_VARIABLES = [
  'WHATSAPP_PROVIDER',
  'VIDEO_PROVIDER',
  'BOT_CHALLENGE',
  'AFIP_PROVIDER',
  'ERX_PROVIDER',
  'PAYMENTS_PROVIDER',
  'WHATSAPP_APP_SECRET',
  'ERX_WEBHOOK_SECRET',
  'MP_WEBHOOK_SECRET',
  'MP_PUBLIC_BASE_URL',
  'VIDEO_ALLOWED_DOMAINS',
  'VIDEO_LOCAL_BASE_URL',
  'ALLOW_LOCAL_PROVIDERS',
  'LOCAL_PROVIDERS_CONSOLE',
  'ADDRESS_HASH_PEPPER',
  'ARCHIVE_S3_BUCKET',
  'ARCHIVE_S3_ENDPOINT',
  'ARCHIVE_S3_REGION',
  'ARCHIVE_S3_ACCESS_KEY_ID',
  'ARCHIVE_S3_SECRET_ACCESS_KEY',
  'ARCHIVE_RETENTION_DAYS',
  'ARCHIVE_AFTER_DAYS',
  'ARCHIVE_RELEASER_PUBLIC_KEY',
  'ARCHIVE_RELEASER_KEK',
] as const;

/** A lowercase host name: what a manual video link may point at. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const MIN_APP_SECRET_LENGTH = 16;
const MIN_PEPPER_LENGTH = 32;
const MIN_WEBHOOK_SECRET_LENGTH = 16;

/** The Jitsi server of the local video provider: https, no credentials, no query or fragment. */
function isServerAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/**
 * The address the payments checkout and webhook are reached on: http or https, no credentials, no
 * query or fragment. Production wants https on top of it (checked where the environment is known).
 */
function isPublicAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

const providerEnv = z.object({
  WHATSAPP_PROVIDER: z.enum(['local', 'meta', 'off']).optional(),
  VIDEO_PROVIDER: z.enum(['local', 'jaas', 'off']).optional(),
  BOT_CHALLENGE: z.enum(['local', 'turnstile']).optional(),
  AFIP_PROVIDER: z.enum(['local', 'afip', 'off']).optional(),
  ERX_PROVIDER: z.enum(['local', 'off']).optional(),
  PAYMENTS_PROVIDER: z.enum(['local', 'off']).optional(),
  /** Signs the WhatsApp webhook (`X-Hub-Signature-256`). Only a secret, never a default. */
  WHATSAPP_APP_SECRET: z.string().min(MIN_APP_SECRET_LENGTH).optional(),
  /** Signs the webhook of the e-prescription provider (HMAC). Only a secret, never a default. */
  ERX_WEBHOOK_SECRET: z.string().min(MIN_WEBHOOK_SECRET_LENGTH).optional(),
  /** Signs the webhook of the payments gateway (HMAC, Mercado Pago's manifest). Only a secret, never a default. */
  MP_WEBHOOK_SECRET: z.string().min(MIN_WEBHOOK_SECRET_LENGTH).optional(),
  /** Where the hosted checkout and the webhook are reached from outside (the platform host). */
  MP_PUBLIC_BASE_URL: z
    .string()
    .refine(isPublicAddress, {
      message: 'must be an http or https address with no credentials, query or fragment',
    })
    .optional(),
  /** Comma-separated host names a professional's manual video link may point at. */
  VIDEO_ALLOWED_DOMAINS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== ''),
    )
    .refine((hosts) => hosts.every((host) => HOSTNAME.test(host)), {
      message: 'must be a comma-separated list of host names without scheme, port or path',
    }),
  /** Where the Jitsi server of `VIDEO_PROVIDER=local` is. Unset: the public server. */
  VIDEO_LOCAL_BASE_URL: z
    .string()
    .refine(isServerAddress, { message: 'must be an https address with no credentials or query' })
    .optional(),
  /**
   * Keys the hash of the addresses in the message log (HMAC-SHA256), the same for the whole
   * platform. Required in production; development has a public default that protects nothing.
   */
  ADDRESS_HASH_PEPPER: z.string().min(MIN_PEPPER_LENGTH).optional(),
  /** The write-once bucket of the retention archive (Object Lock). Unset: nothing is archived. */
  ARCHIVE_S3_BUCKET: z.string().min(3).max(63).optional(),
  ARCHIVE_S3_ENDPOINT: z
    .string()
    .refine(isPublicAddress, { message: 'must be an http or https address with no credentials' })
    .optional(),
  ARCHIVE_S3_REGION: z.string().min(1).default('us-east-1'),
  /** The identity that writes the archive (it can write, read and list; it can not delete). */
  ARCHIVE_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  ARCHIVE_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** How long an archived object cannot be altered or removed (the 10-year legal retention). */
  ARCHIVE_RETENTION_DAYS: z.coerce.number().int().min(1).max(36_500).default(3650),
  /** Days after the cancellation before the archive is written: the window of the export. */
  ARCHIVE_AFTER_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** The public half of the key of the releaser (32 bytes, base64): lets the writer seal, not open. */
  ARCHIVE_RELEASER_PUBLIC_KEY: z.string().min(1).optional(),
  /** The private half (32 bytes, base64). ONLY the releaser process has it. */
  ARCHIVE_RELEASER_KEK: z.string().min(1).optional(),
  ALLOW_LOCAL_PROVIDERS: booleanFlag.default(false),
  LOCAL_PROVIDERS_CONSOLE: booleanFlag.default(false),
});

/** The retention archive (Stage 6), present when its bucket and its keys are configured. */
export interface ArchiveConfig {
  readonly storage: {
    readonly bucket: string;
    readonly region: string;
    readonly endpoint: string;
    readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
  };
  readonly retentionDays: number;
  readonly afterDays: number;
  /** What the writers seal with: always set when the archive is. */
  readonly releaserPublicKey: string;
  /** Set only in the environment of the releaser. */
  readonly releaserKek?: string;
}

export interface ProviderConfig extends ProviderSelection {
  /** Set when the archive bucket and the key of the releaser are configured. */
  readonly archive?: ArchiveConfig;
  /** Set when `WHATSAPP_APP_SECRET` is. Required for the real provider. */
  readonly whatsappAppSecret?: string;
  /** Set when `ERX_WEBHOOK_SECRET` is. The provider webhook is refused without it. */
  readonly erxWebhookSecret?: string;
  /** Set when `MP_WEBHOOK_SECRET` is. The payments webhook is refused without it. */
  readonly mpWebhookSecret?: string;
  /** Set when `MP_PUBLIC_BASE_URL` is; without it the gateway builds addresses on the platform host. */
  readonly mpPublicBaseUrl?: string;
  /** Keys the address hashes of the message log; set in production, optional elsewhere. */
  readonly addressHashPepper?: string;
  readonly videoAllowedDomains: readonly string[];
  /** The Jitsi server the local video provider builds addresses on; unset means the public one. */
  readonly videoLocalBaseUrl?: string;
  /** Production may run the simulators (a demo or staging deployment). */
  readonly allowLocalProviders: boolean;
  /** `/operator/dev/*` exists only when this is true. */
  readonly localProvidersConsole: boolean;
}

export type ProviderEnvProblem = { path: string; message: string };

/**
 * Reads the provider settings. Outside production a provider that is not named runs on its local
 * simulator; production defaults to "no simulator" (WhatsApp and video off, the real bot
 * challenge), so an existing production configuration keeps starting. The problems carry variable
 * names and messages, never values.
 */
export function readProviderConfig(
  env: NodeJS.ProcessEnv,
  context: { nodeEnv: NodeEnvironment },
): { config?: ProviderConfig; problems: ProviderEnvProblem[] } {
  const parsed = providerEnv.safeParse(env);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    };
  }
  const value = parsed.data;
  const production = context.nodeEnv === 'production';
  const selection: ProviderSelection = {
    whatsapp: value.WHATSAPP_PROVIDER ?? (production ? 'off' : 'local'),
    video: value.VIDEO_PROVIDER ?? (production ? 'off' : 'local'),
    botChallenge: value.BOT_CHALLENGE ?? (production ? 'turnstile' : 'local'),
    afip: value.AFIP_PROVIDER ?? (production ? 'off' : 'local'),
    erx: value.ERX_PROVIDER ?? (production ? 'off' : 'local'),
    payments: value.PAYMENTS_PROVIDER ?? (production ? 'off' : 'local'),
  };

  const problems: ProviderEnvProblem[] = checkLocalProviders({
    nodeEnv: context.nodeEnv,
    selection,
    allowLocalProviders: value.ALLOW_LOCAL_PROVIDERS,
    localProvidersConsole: value.LOCAL_PROVIDERS_CONSOLE,
  });
  if (selection.whatsapp === 'meta' && value.WHATSAPP_APP_SECRET === undefined) {
    problems.push({
      path: 'WHATSAPP_APP_SECRET',
      message: 'is required when WHATSAPP_PROVIDER is meta (the webhook is signed with it)',
    });
  }
  if (
    production &&
    value.MP_PUBLIC_BASE_URL !== undefined &&
    !value.MP_PUBLIC_BASE_URL.startsWith('https://')
  ) {
    problems.push({
      path: 'MP_PUBLIC_BASE_URL',
      message: 'must be an https address in production (the payments provider calls it back)',
    });
  }
  if (production && value.ADDRESS_HASH_PEPPER === undefined) {
    problems.push({
      path: 'ADDRESS_HASH_PEPPER',
      message: `is required in production (at least ${String(MIN_PEPPER_LENGTH)} characters, secret): it keys the hash of the addresses in the message log`,
    });
  }
  const archive = readArchiveConfig(value, problems, production);
  if (problems.length > 0) return { problems };

  return {
    config: {
      ...selection,
      ...(archive ? { archive } : {}),
      ...(value.WHATSAPP_APP_SECRET === undefined
        ? {}
        : { whatsappAppSecret: value.WHATSAPP_APP_SECRET }),
      ...(value.ERX_WEBHOOK_SECRET === undefined
        ? {}
        : { erxWebhookSecret: value.ERX_WEBHOOK_SECRET }),
      ...(value.MP_WEBHOOK_SECRET === undefined
        ? {}
        : { mpWebhookSecret: value.MP_WEBHOOK_SECRET }),
      ...(value.MP_PUBLIC_BASE_URL === undefined
        ? {}
        : { mpPublicBaseUrl: value.MP_PUBLIC_BASE_URL }),
      ...(value.ADDRESS_HASH_PEPPER === undefined
        ? {}
        : { addressHashPepper: value.ADDRESS_HASH_PEPPER }),
      videoAllowedDomains: value.VIDEO_ALLOWED_DOMAINS,
      ...(value.VIDEO_LOCAL_BASE_URL === undefined
        ? {}
        : { videoLocalBaseUrl: value.VIDEO_LOCAL_BASE_URL }),
      allowLocalProviders: value.ALLOW_LOCAL_PROVIDERS,
      localProvidersConsole: value.LOCAL_PROVIDERS_CONSOLE,
    },
    problems: [],
  };
}

/**
 * The key of the releaser that `infra/docker-compose.yml` runs on: it is printed in the repository, so
 * nothing sealed to it is secret. Production refuses it, as the private half and as the public one.
 */
const DEVELOPMENT_RELEASER_KEK = 'ZGV2X29ubHlfYXJjaGl2ZV9yZWxlYXNlcl9rZWtfMDA=';

/** The archive settings, or nothing when no bucket is named. A half-configured archive is a problem. */
function readArchiveConfig(
  value: z.infer<typeof providerEnv>,
  problems: ProviderEnvProblem[],
  production: boolean,
): ArchiveConfig | undefined {
  if (value.ARCHIVE_S3_BUCKET === undefined) {
    for (const name of ['ARCHIVE_RELEASER_PUBLIC_KEY', 'ARCHIVE_RELEASER_KEK'] as const) {
      if (value[name] !== undefined) {
        problems.push({ path: name, message: 'is set but ARCHIVE_S3_BUCKET is not' });
      }
    }
    return undefined;
  }
  const required = {
    ARCHIVE_S3_ENDPOINT: value.ARCHIVE_S3_ENDPOINT,
    ARCHIVE_S3_ACCESS_KEY_ID: value.ARCHIVE_S3_ACCESS_KEY_ID,
    ARCHIVE_S3_SECRET_ACCESS_KEY: value.ARCHIVE_S3_SECRET_ACCESS_KEY,
  };
  for (const [name, entry] of Object.entries(required)) {
    if (entry === undefined) {
      problems.push({ path: name, message: 'is required when ARCHIVE_S3_BUCKET is set' });
    }
  }
  if (production) {
    // The records of cancelled organizations do not travel in the clear, and are not sealed to a key
    // that is printed in the repository (JD-S6 R1-A-T12).
    if (value.ARCHIVE_S3_ENDPOINT?.toLowerCase().startsWith('http://')) {
      problems.push({
        path: 'ARCHIVE_S3_ENDPOINT',
        message: 'must be https in production',
      });
    }
    if (value.ARCHIVE_RELEASER_KEK === DEVELOPMENT_RELEASER_KEK) {
      problems.push({
        path: 'ARCHIVE_RELEASER_KEK',
        message: 'is the public development key of the repository and is not allowed in production',
      });
    }
    if (value.ARCHIVE_RELEASER_PUBLIC_KEY === releaserPublicKeyOf(DEVELOPMENT_RELEASER_KEK)) {
      problems.push({
        path: 'ARCHIVE_RELEASER_PUBLIC_KEY',
        message:
          'is the public half of the development key of the repository and is not allowed in production',
      });
    }
  }
  // The public key can be derived from the private one, so the releaser needs only the latter.
  let publicKey = value.ARCHIVE_RELEASER_PUBLIC_KEY;
  if (value.ARCHIVE_RELEASER_KEK !== undefined) {
    try {
      const derived = releaserPublicKeyOf(value.ARCHIVE_RELEASER_KEK);
      if (publicKey !== undefined && publicKey !== derived) {
        problems.push({
          path: 'ARCHIVE_RELEASER_PUBLIC_KEY',
          message: 'is not the public half of ARCHIVE_RELEASER_KEK',
        });
      }
      publicKey ??= derived;
    } catch {
      problems.push({ path: 'ARCHIVE_RELEASER_KEK', message: 'must be 32 bytes in base64' });
    }
  } else if (publicKey !== undefined) {
    try {
      if (Buffer.from(publicKey, 'base64').length !== 32) throw new Error('length');
    } catch {
      problems.push({ path: 'ARCHIVE_RELEASER_PUBLIC_KEY', message: 'must be 32 bytes in base64' });
    }
  }
  if (publicKey === undefined) {
    problems.push({
      path: 'ARCHIVE_RELEASER_PUBLIC_KEY',
      message: 'is required when ARCHIVE_S3_BUCKET is set: the archive is sealed to the releaser',
    });
  }
  if (
    required.ARCHIVE_S3_ENDPOINT === undefined ||
    required.ARCHIVE_S3_ACCESS_KEY_ID === undefined ||
    required.ARCHIVE_S3_SECRET_ACCESS_KEY === undefined ||
    publicKey === undefined
  ) {
    return undefined;
  }
  return {
    storage: {
      bucket: value.ARCHIVE_S3_BUCKET,
      region: value.ARCHIVE_S3_REGION,
      endpoint: required.ARCHIVE_S3_ENDPOINT,
      credentials: {
        accessKeyId: required.ARCHIVE_S3_ACCESS_KEY_ID,
        secretAccessKey: required.ARCHIVE_S3_SECRET_ACCESS_KEY,
      },
    },
    retentionDays: value.ARCHIVE_RETENTION_DAYS,
    afterDays: value.ARCHIVE_AFTER_DAYS,
    releaserPublicKey: publicKey,
    ...(value.ARCHIVE_RELEASER_KEK === undefined
      ? {}
      : { releaserKek: value.ARCHIVE_RELEASER_KEK }),
  };
}
