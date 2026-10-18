import type { SlotContribution } from '../../app/registry.js';

import { CloseEntryPrompt } from './components/CloseEntryPrompt.js';

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
