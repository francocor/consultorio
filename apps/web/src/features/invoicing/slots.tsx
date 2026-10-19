import { lazySlot } from '../../app/lazy-slot.js';
import type { SlotContribution, SlotProps } from '../../app/registry.js';

// The panel loads when a drawer opens it: the sign-in page does not pay for it.
const ChargeInvoicesPanel = lazySlot<SlotProps['appointment-drawer']>(() =>
  import('./components/ChargeInvoicesPanel.js').then((module) => ({
    default: module.ChargeInvoicesPanel,
  })),
);

/**
 * What invoicing mounts inside screens that other features own: the invoices of the charge of the
 * appointment, with the actions to ask for another or to register one, under the charge itself.
 */
const drawer: SlotContribution<'appointment-drawer'> = {
  slot: 'appointment-drawer',
  id: 'invoicing.invoices',
  order: 65,
  anyOf: ['invoicing.issue'],
  Component: ChargeInvoicesPanel,
};

const slots: readonly SlotContribution<'appointment-drawer'>[] = [drawer];

export default slots;
