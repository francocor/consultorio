/**
 * Local-provider gating (Stages 3 to 6, "Local-first provider rules").
 *
 * Every external provider has a LOCAL adapter: a working simulator that needs no account. The
 * simulators are what the product runs on while the owner has no contract with the real provider,
 * so outside production nothing is refused. A production process that selects a simulator would
 * send nothing to a real patient and pretend it did, so it refuses to start unless somebody said,
 * with `ALLOW_LOCAL_PROVIDERS=true`, that this is a demo or a staging deployment.
 */

export type NodeEnvironment = 'development' | 'test' | 'production';

/** The provider variables that have a local simulator. Each later stage adds its own. */
export interface ProviderSelection {
  /** `WHATSAPP_PROVIDER`: the sender of WhatsApp messages. */
  whatsapp: 'local' | 'meta' | 'off';
  /** `VIDEO_PROVIDER`: the video-room provider of teleconsultations. */
  video: 'local' | 'jaas' | 'off';
  /** `BOT_CHALLENGE`: the bot challenge of the public forms. */
  botChallenge: 'local' | 'turnstile';
  /** `AFIP_PROVIDER`: the issuer of electronic invoices (Stage 4). */
  afip: 'local' | 'afip' | 'off';
  /** `ERX_PROVIDER`: the e-prescription platform (Stage 5). The real provider key arrives with its adapter. */
  erx: 'local' | 'off';
}

const VARIABLE_OF: Record<keyof ProviderSelection, string> = {
  whatsapp: 'WHATSAPP_PROVIDER',
  video: 'VIDEO_PROVIDER',
  botChallenge: 'BOT_CHALLENGE',
  afip: 'AFIP_PROVIDER',
  erx: 'ERX_PROVIDER',
};

/** The names of the variables whose value is a local simulator, in a stable order. */
export function localProvidersIn(selection: ProviderSelection): string[] {
  return (Object.keys(VARIABLE_OF) as (keyof ProviderSelection)[])
    .filter((provider) => selection[provider] === 'local')
    .map((provider) => VARIABLE_OF[provider]);
}

export interface LocalProviderCheck {
  nodeEnv: NodeEnvironment;
  selection: ProviderSelection;
  allowLocalProviders: boolean;
  localProvidersConsole: boolean;
}

export interface LocalProviderProblem {
  path: string;
  message: string;
}

/**
 * The reasons a configuration may not start. Only production is guarded, and the flag lifts every
 * refusal at once. The messages name variables, never values.
 */
export function checkLocalProviders(check: LocalProviderCheck): LocalProviderProblem[] {
  if (check.nodeEnv !== 'production' || check.allowLocalProviders) return [];
  const problems: LocalProviderProblem[] = localProvidersIn(check.selection).map((path) => ({
    path,
    message:
      'selects a local simulator in production; set ALLOW_LOCAL_PROVIDERS=true only for a demo or staging deployment, or select the real provider',
  }));
  if (check.localProvidersConsole) {
    problems.push({
      path: 'LOCAL_PROVIDERS_CONSOLE',
      message:
        'exposes the simulator console in production; it needs ALLOW_LOCAL_PROVIDERS=true and is for a demo or staging deployment only',
    });
  }
  return problems;
}
