/**
 * The tenant's look, applied before the first paint.
 *
 * This module is also compiled into a tiny inline script in `index.html` (see
 * `vite/theme-boot-plugin.ts`), so it must stay free of imports other than types. It stores the
 * theme tokens of each host (colors, radius, font name: never personal or clinical data) so a
 * returning visitor sees the right look immediately; a first visit holds the first paint for a
 * moment instead of flashing the neutral theme.
 */
import type { BootPayload } from '@consultorio/contracts';

export type BootTheme = BootPayload['theme'];

export const THEME_STORAGE_PREFIX = 'consultorio:theme:';
export const COLOR_SCHEME_STORAGE_KEY = 'consultorio:color-scheme';

/** The neutral product color, used whenever a stored or received color is not usable. */
const DEFAULT_PRIMARY = '#0f766e';
const DEFAULT_FOREGROUND = '#ffffff';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const RADIUS: Record<BootTheme['radius'], string> = {
  none: '0rem',
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
};

const FONT_STACKS: Record<BootTheme['headingFont'], string> = {
  inter: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
  source_sans: "'Source Sans 3 Variable', ui-sans-serif, system-ui, sans-serif",
  poppins: "'Poppins', ui-sans-serif, system-ui, sans-serif",
  lora: "'Lora Variable', Georgia, 'Times New Roman', serif",
  merriweather: "'Merriweather Variable', Georgia, 'Times New Roman', serif",
};

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}

/** Semantic variables only: components never read a raw color. */
export function themeToCssVariables(theme: BootTheme): Record<string, string> {
  const primary = color(theme.primary, DEFAULT_PRIMARY);
  return {
    '--primary': primary,
    '--primary-foreground': color(theme.primaryForeground, DEFAULT_FOREGROUND),
    '--ring': primary,
    '--radius': RADIUS[theme.radius],
    '--font-heading': FONT_STACKS[theme.headingFont],
  };
}

export function applyTheme(root: HTMLElement, theme: BootTheme): void {
  for (const [name, value] of Object.entries(themeToCssVariables(theme))) {
    root.style.setProperty(name, value);
  }
}

export type ColorSchemePreference = 'light' | 'dark' | 'system';

export function applyColorScheme(
  root: HTMLElement,
  preference: string | null,
  systemPrefersDark: boolean,
): void {
  const dark = preference === 'dark' || (preference === 'system' && systemPrefersDark);
  root.classList.toggle('dark', dark);
}

const RADIUS_STEPS = Object.keys(RADIUS);
const FONT_NAMES = Object.keys(FONT_STACKS);

function isBootTheme(value: unknown): value is BootTheme {
  if (typeof value !== 'object' || value === null) return false;
  const theme = value as Record<string, unknown>;
  return (
    typeof theme['primary'] === 'string' &&
    HEX_COLOR.test(theme['primary']) &&
    typeof theme['primaryForeground'] === 'string' &&
    typeof theme['radius'] === 'string' &&
    RADIUS_STEPS.includes(theme['radius']) &&
    typeof theme['headingFont'] === 'string' &&
    FONT_NAMES.includes(theme['headingFont'])
  );
}

function readItem(storage: Pick<Storage, 'getItem'>, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function readStoredTheme(storage: Pick<Storage, 'getItem'>, key: string): BootTheme | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isBootTheme(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ThemeBootOptions {
  root: HTMLElement;
  /** `location.host`: a theme belongs to a host, so tenants never see each other's. */
  host: string;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  fetch: typeof fetch;
  prefersDark: () => boolean;
  /** How long the first paint of a first visit may wait for the server. */
  timeoutMs: number;
}

/**
 * Runs before the first paint: restores the color scheme, applies the stored theme of this host
 * synchronously, and fetches the current boot payload. The returned promise resolves with the
 * payload (or null) so the app can reuse it instead of asking again.
 */
export function runThemeBoot(options: ThemeBootOptions): Promise<BootPayload | null> {
  const { root, host, storage } = options;
  const key = `${THEME_STORAGE_PREFIX}${host}`;

  applyColorScheme(root, readItem(storage, COLOR_SCHEME_STORAGE_KEY), options.prefersDark());

  const cached = readStoredTheme(storage, key);
  if (cached) {
    applyTheme(root, cached);
  } else {
    root.setAttribute('data-boot', 'pending');
  }

  const reveal = () => {
    root.removeAttribute('data-boot');
  };

  const request = options
    .fetch('/api/public/boot', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    .then(async (response): Promise<BootPayload | null> => {
      if (!response.ok) return null;
      const payload = (await response.json()) as { theme?: unknown };
      if (!isBootTheme(payload.theme)) return null;
      applyTheme(root, payload.theme);
      try {
        storage.setItem(key, JSON.stringify(payload.theme));
      } catch {
        // Storage can be unavailable (private mode); the look is still applied for this visit.
      }
      return payload as BootPayload;
    })
    .catch(() => null);

  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, options.timeoutMs);
  });

  return Promise.race([request, timeout]).then((payload) => {
    reveal();
    return payload;
  });
}

declare global {
  interface Window {
    /** Resolves with the boot payload fetched before the first paint, or null if it failed. */
    __CONSULTORIO_BOOT__?: Promise<BootPayload | null>;
  }
}

/** Storage that never throws: private modes and locked-down browsers can refuse access. */
function safeStorage(win: Window): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    return win.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
}

/** The single call the inline script in `index.html` makes. */
export function startThemeBoot(win: Window): void {
  win.__CONSULTORIO_BOOT__ = runThemeBoot({
    root: win.document.documentElement,
    host: win.location.host,
    storage: safeStorage(win),
    fetch: win.fetch.bind(win),
    prefersDark: () => win.matchMedia('(prefers-color-scheme: dark)').matches,
    timeoutMs: 1500,
  });
}
