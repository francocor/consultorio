import { lazySlot } from '../../app/lazy-slot.js';
import type { SettingsArea, SlotContribution, SlotProps } from '../../app/registry.js';

/** The areas of the settings this section belongs to. */
const SETTINGS_AREAS: readonly SettingsArea[] = ['scheduling'];

const VideoSessionPanel = lazySlot<SlotProps['appointment-drawer']>(() =>
  import('./components/VideoSessionPanel.js').then((module) => ({
    default: module.VideoSessionPanel,
  })),
);

const VideoJoinButton = lazySlot<SlotProps['today-appointment']>(() =>
  import('./components/VideoJoinButton.js').then((module) => ({
    default: module.VideoJoinButton,
  })),
);

const VideoSettings = lazySlot<SlotProps['settings-section']>(() =>
  import('./components/VideoSettingsSection.js').then((module) => ({
    default: ({ area }) => (SETTINGS_AREAS.includes(area) ? <module.VideoSettingsSection /> : null),
  })),
);

/**
 * What the teleconsultation feature mounts inside screens that other features own:
 *
 * - the video panel of the appointment drawer (virtual marker, link state, Join, manual link);
 * - the "join" button beside a virtual appointment of the professional's day;
 * - the video section of the scheduling settings, for whoever manages the organization.
 */
const slots: readonly (
  | SlotContribution<'appointment-drawer'>
  | SlotContribution<'settings-section'>
  | SlotContribution<'today-appointment'>
)[] = [
  {
    slot: 'appointment-drawer',
    id: 'teleconsultation.video-session',
    order: 20,
    anyOf: ['scheduling.read'],
    Component: VideoSessionPanel,
  },
  {
    slot: 'today-appointment',
    id: 'teleconsultation.join',
    order: 20,
    anyOf: ['scheduling.read'],
    Component: VideoJoinButton,
  },
  {
    slot: 'settings-section',
    id: 'teleconsultation.settings',
    order: 40,
    anyOf: ['tenant.settings.manage'],
    Component: VideoSettings,
  },
];

export default slots;
