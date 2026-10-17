import { lazySlot } from '../../../app/lazy-slot.js';
import type { SlotContribution, SlotProps } from '../../../app/registry.js';

const MessageLog = lazySlot<SlotProps['appointment-drawer']>(() =>
  import('./components/MessageLog.js').then((module) => ({ default: module.MessageLog })),
);

const ChannelsPanel = lazySlot<SlotProps['patient-detail-tab']>(() =>
  import('./components/ChannelsPanel.js').then((module) => ({ default: module.ChannelsPanel })),
);

/**
 * What messaging mounts inside screens that other features own: the message log in the appointment
 * drawer (for whoever may read the log) and the channels of a patient as a tab of the record.
 */
const slots: readonly (
  SlotContribution<'appointment-drawer'> | SlotContribution<'patient-detail-tab'>
)[] = [
  {
    slot: 'appointment-drawer',
    id: 'message-log',
    order: 60,
    anyOf: ['notifications.log.read'],
    Component: MessageLog,
  },
  {
    slot: 'patient-detail-tab',
    id: 'channels',
    order: 60,
    anyOf: ['patients.read'],
    labelKey: 'messaging:channels.tab',
    Component: ChannelsPanel,
  },
];

export default slots;
