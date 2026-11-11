import { lazySlot } from '../../../app/lazy-slot.js';
import type { SlotContribution, SlotProps } from '../../../app/registry.js';

const MessageLog = lazySlot<SlotProps['appointment-drawer']>(() =>
  import('./components/MessageLog.js').then((module) => ({ default: module.MessageLog })),
);

const ChannelsPanel = lazySlot<SlotProps['patient-detail-tab']>(() =>
  import('./components/ChannelsPanel.js').then((module) => ({ default: module.ChannelsPanel })),
);

const NoMessagesBadge = lazySlot<SlotProps['patient-header']>(() =>
  import('./components/NoMessagesBadge.js').then((module) => ({ default: module.NoMessagesBadge })),
);

/**
 * What messaging mounts inside screens that other features own: the message log in the appointment
 * drawer (for whoever may read the log), the channels of a patient as a tab of the record and the
 * "Sin avisos" mark in the header of the record.
 */
const slots: readonly (
  | SlotContribution<'appointment-drawer'>
  | SlotContribution<'patient-detail-tab'>
  | SlotContribution<'patient-header'>
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
  {
    slot: 'patient-header',
    id: 'no-messages',
    order: 60,
    anyOf: ['patients.read'],
    Component: NoMessagesBadge,
  },
];

export default slots;
