/**
 * Display preferences kept on the device: the color scheme and whether the sidebar is collapsed.
 * They are not personal data, which is why this is one of the few files allowed to use browser
 * storage (see the lint rule). Nothing else is ever stored.
 */
import {
  applyColorScheme,
  applyTheme,
  COLOR_SCHEME_STORAGE_KEY,
  THEME_STORAGE_PREFIX,
  type BootTheme,
  type ColorSchemePreference,
} from './theme-boot.js';

const SIDEBAR_KEY = 'consultorio:sidebar-collapsed';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readColorScheme(): ColorSchemePreference {
  const value = storage()?.getItem(COLOR_SCHEME_STORAGE_KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function writeColorScheme(preference: ColorSchemePreference): void {
  try {
    storage()?.setItem(COLOR_SCHEME_STORAGE_KEY, preference);
  } catch {
    // The choice still applies to this visit.
  }
  applyColorScheme(
    document.documentElement,
    preference,
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
}

export function readSidebarCollapsed(): boolean {
  return storage()?.getItem(SIDEBAR_KEY) === 'true';
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    storage()?.setItem(SIDEBAR_KEY, String(collapsed));
  } catch {
    // Not remembering is harmless.
  }
}

/**
 * A new look of the organization (its branding was just saved): applied now and kept for this host,
 * so the next load paints it from the first frame instead of the previous one.
 */
export function rememberTheme(theme: BootTheme): void {
  applyTheme(document.documentElement, theme);
  try {
    storage()?.setItem(`${THEME_STORAGE_PREFIX}${window.location.host}`, JSON.stringify(theme));
  } catch {
    // The look still applies to this visit.
  }
}
