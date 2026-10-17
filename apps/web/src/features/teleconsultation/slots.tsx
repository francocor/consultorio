import type { SettingsArea, SlotContribution } from '../../app/registry.js';

import { VideoSessionPanel } from './components/VideoSessionPanel.js';
import { VideoSettingsSection } from './components/VideoSettingsSection.js';

/** The areas of the settings this section belongs to. */
const SETTINGS_AREAS: readonly SettingsArea[] = ['scheduling'];

/**
 * What the teleconsultation feature mounts inside screens that other features own:
 *
 * - the video panel of the appointment drawer (virtual marker, link state, Join, manual link);
 * - the video section of the scheduling settings, for whoever manages the organization.
 */
const slots: readonly (
  SlotContribution<'appointment-drawer'> | SlotContribution<'settings-section'>
)[] = [
  {
    slot: 'appointment-drawer',
    id: 'teleconsultation.video-session',
    order: 20,
    anyOf: ['scheduling.read'],
    Component: VideoSessionPanel,
  },
  {
    slot: 'settings-section',
    id: 'teleconsultation.settings',
    order: 40,
    anyOf: ['tenant.settings.manage'],
    Component: ({ area }) => (SETTINGS_AREAS.includes(area) ? <VideoSettingsSection /> : null),
  },
];

export default slots;
