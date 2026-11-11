/**
 * Whether `pnpm demo:platform` may run against this configuration. It answers the reason it must
 * not, or null. The organizations it creates have a public password and a fictional subscription,
 * so a production database is refused first; the rest are the conditions without which there is no
 * platform to show (several organizations, each on its own host).
 */
export function platformDemoRefusal(settings: {
  nodeEnv: string;
  deploymentMode: string;
  baseDomain?: string | undefined;
}): string | null {
  if (settings.nodeEnv === 'production') {
    return 'The platform demo never runs in production: its organizations use the public demo password.';
  }
  if (settings.deploymentMode !== 'multi') {
    return 'The platform demo needs DEPLOYMENT_MODE=multi: a single-tenant deployment has no platform to show.';
  }
  if (!settings.baseDomain) {
    return 'The platform demo needs BASE_DOMAIN (each organization is reached on its own host).';
  }
  return null;
}
