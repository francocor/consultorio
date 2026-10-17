import { DEFAULT_INVOICING_SETTINGS, InvoicingSettings } from '@consultorio/contracts';

import { createFakeInvoiceIssuer } from '../../adapters/afip-fake/index.js';
import { createInvoicing } from '../../modules/invoicing/index.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { fake } from '../adapter-resolver.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the invoicing module registers with the composition root (Track C). The track edits
 * this file, `modules/invoicing/` and nothing shared: it fills the customer slot of the
 * `invoiceIssuer` port when its AFIP simulator exists (`adapters/afip-local`), sets `needsJobs` for
 * `afip.issue`, adds its jobs to the worker and the simulator controls to the provider console.
 */
export const invoicingWiring: ModuleWiring = {
  name: 'invoicing',
  settingsSections: [
    { key: 'invoicing', schema: InvoicingSettings, defaults: DEFAULT_INVOICING_SETTINGS },
  ],
  // No customer adapter yet: nothing is issued for customers; demo organizations get the fake.
  adapters: () => ({
    invoiceIssuer: { real: undefined, demo: fake(createFakeInvoiceIssuer()) },
  }),
  devProviders: ({ config }) => [
    {
      id: 'afip',
      label: 'AFIP',
      // The simulator adds its mode (ok, down, slow, ...) when it exists.
      status: () =>
        Promise.resolve({ adapter: adapterOfSetting(config.providers.afip), mode: null }),
    },
  ],
  create: (context) =>
    createInvoicing({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};
