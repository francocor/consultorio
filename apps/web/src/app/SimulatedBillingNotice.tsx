import { SimulatedBillingBanner } from '../shared/ui/states/banners.js';

import { useBoot } from './boot.js';

/**
 * Tells the person that the invoices they are looking at are test documents, when they are: a demo
 * organization only ever has the fake issuer, and a deployment that runs the local AFIP simulator
 * says so in the boot payload (`localProviders.afip`). Billing, cash and invoicing screens mount
 * it at the top. It draws nothing until the boot payload is known, so a real deployment never
 * flashes a banner it does not need.
 */
export function SimulatedBillingNotice({ className }: { className?: string }) {
  const boot = useBoot();
  if (!boot || !(boot.isDemo || boot.localProviders.afip)) return null;
  return <SimulatedBillingBanner {...(className === undefined ? {} : { className })} />;
}
