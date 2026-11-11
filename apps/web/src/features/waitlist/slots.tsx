import { lazySlot } from '../../app/lazy-slot.js';
import type { SlotContribution, SlotProps } from '../../app/registry.js';

// The prompt loads when an appointment drawer opens: the sign-in page does not pay for it (it
// brings the dialog, the toast library and the waitlist client along).
const CloseEntryPrompt = lazySlot<SlotProps['appointment-drawer']>(() =>
  import('./components/CloseEntryPrompt.js').then((module) => ({
    default: module.CloseEntryPrompt,
  })),
);

/**
 * What the waitlist mounts inside screens that other features own: in the appointment drawer, the
 * suggestion to close the entry of a patient who was just given the turn they were waiting for.
 */
const slots: readonly SlotContribution<'appointment-drawer'>[] = [
  {
    slot: 'appointment-drawer',
    id: 'waitlist.close-prompt',
    order: 70,
    anyOf: ['waitlist.manage'],
    Component: CloseEntryPrompt,
  },
];

export default slots;
