import {
  RECIPIENT_TAX_CONDITIONS,
  type InvoicingOptionsDto,
  type TaxCondition,
} from '@consultorio/contracts';
import { asc } from 'drizzle-orm';

import { fiscalProfile, pointOfSale } from '../../../db/schema/index.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { packFor } from './country-rules.js';
import { effectiveEnvironment, type FiscalDeps } from './fiscal-config.js';
import { isSimulatedIssuer, issuerFor } from './issuer.js';
import { loadOrganization } from './settings.js';

/**
 * What the form of an invoice needs: the voucher type the rules of the country give for each kind of
 * recipient (so the screen shows it and never offers a type beyond them), and the points of sale
 * that can be used. It carries nothing of the fiscal configuration that only the owner and the
 * administration read (no CUIT, no address, no certificate).
 */
export async function invoicingOptions(tx: Tx, deps: FiscalDeps): Promise<InvoicingOptionsDto> {
  const organization = await loadOrganization(tx);
  const [profile] = await tx.select().from(fiscalProfile);
  const simulated = isSimulatedIssuer(
    issuerFor(deps.adapters, { id: organization.id, isDemo: organization.isDemo }),
  );
  const points = await tx.select().from(pointOfSale).orderBy(asc(pointOfSale.number));
  const rules = packFor(organization.country).invoiceRules;

  const types: InvoicingOptionsDto['types'] = [];
  if (profile) {
    for (const recipient of RECIPIENT_TAX_CONDITIONS) {
      const given = rules.resolveInvoiceType({
        issuer: profile.taxCondition as TaxCondition,
        recipient,
      });
      if (given.ok) types.push({ recipient, type: given.value });
    }
  }
  return {
    taxCondition: profile ? (profile.taxCondition as TaxCondition) : null,
    types,
    pointsOfSale: points
      .filter((point) => point.active)
      .map((point) => ({
        number: point.number,
        environment: effectiveEnvironment(point.environment, simulated),
      })),
  };
}
