import type { SlotContribution } from '../../../app/registry.js';

import { ChannelsPanel } from './components/ChannelsPanel.js';
import { MessageLog } from './components/MessageLog.js';

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
    Component: ({ patientId }) => <ChannelsPanel patientId={patientId} />,
  },
];

export default slots;
