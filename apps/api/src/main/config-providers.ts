import { z } from 'zod';

import {
  checkLocalProviders,
  type NodeEnvironment,
  type ProviderSelection,
} from '../platform/local-providers/guard.js';

/**
 * The provider variables of the patient-engagement stages. They are documented in
 * `docs/dev-setup.md` (a test checks it). Every later stage that adds a provider adds its
 * variables here, so the shared `config.ts` stays untouched.
 */
export const PROVIDER_ENV_VARIABLES = [
  'WHATSAPP_PROVIDER',
  'VIDEO_PROVIDER',
  'BOT_CHALLENGE',
  'WHATSAPP_APP_SECRET',
  'VIDEO_ALLOWED_DOMAINS',
  'VIDEO_LOCAL_BASE_URL',
  'ALLOW_LOCAL_PROVIDERS',
  'LOCAL_PROVIDERS_CONSOLE',
] as const;

/** A lowercase host name: what a manual video link may point at. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const MIN_APP_SECRET_LENGTH = 16;

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

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

const providerEnv = z.object({
  WHATSAPP_PROVIDER: z.enum(['local', 'meta', 'off']).optional(),
  VIDEO_PROVIDER: z.enum(['local', 'jaas', 'off']).optional(),
  BOT_CHALLENGE: z.enum(['local', 'turnstile']).optional(),
  /** Signs the WhatsApp webhook (`X-Hub-Signature-256`). Only a secret, never a default. */
  WHATSAPP_APP_SECRET: z.string().min(MIN_APP_SECRET_LENGTH).optional(),
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
  ALLOW_LOCAL_PROVIDERS: booleanFlag.default(false),
  LOCAL_PROVIDERS_CONSOLE: booleanFlag.default(false),
});

export interface ProviderConfig extends ProviderSelection {
  /** Set when `WHATSAPP_APP_SECRET` is. Required for the real provider. */
  readonly whatsappAppSecret?: string;
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
  if (problems.length > 0) return { problems };

  return {
    config: {
      ...selection,
      ...(value.WHATSAPP_APP_SECRET === undefined
        ? {}
        : { whatsappAppSecret: value.WHATSAPP_APP_SECRET }),
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
