import { FirstRunChecklist } from '../features/onboarding/FirstRunChecklist.js';

/**
 * Where the guided first run of a new organization lives (app-shell-ux, "Guided first run hook"):
 * shown to the people who run it, until it is finished or dismissed, and never to anyone else. The
 * shell owns the place; the content and the completion rules belong to the onboarding feature.
 */
export function FirstRunSlot() {
  return <FirstRunChecklist />;
}
