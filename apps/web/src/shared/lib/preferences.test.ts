import { beforeEach, describe, expect, it } from 'vitest';

import {
  readColorScheme,
  rememberTheme,
  readSidebarCollapsed,
  writeColorScheme,
  writeSidebarCollapsed,
} from './preferences.js';
import { THEME_STORAGE_PREFIX } from './theme-boot.js';

describe('display preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('defaults to following the device', () => {
    expect(readColorScheme()).toBe('system');
  });

  it('remembers a chosen color scheme and applies it to the page', () => {
    writeColorScheme('dark');

    expect(readColorScheme()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    writeColorScheme('light');
    expect(readColorScheme()).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('ignores a stored value it does not know', () => {
    localStorage.setItem('consultorio:color-scheme', 'neon');

    expect(readColorScheme()).toBe('system');
  });

  it('remembers the sidebar state', () => {
    expect(readSidebarCollapsed()).toBe(false);

    writeSidebarCollapsed(true);
    expect(readSidebarCollapsed()).toBe(true);

    writeSidebarCollapsed(false);
    expect(readSidebarCollapsed()).toBe(false);
  });

  it('never throws when storage is blocked', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      expect(readColorScheme()).toBe('system');
      expect(() => {
        writeColorScheme('dark');
      }).not.toThrow();
      expect(readSidebarCollapsed()).toBe(false);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('remembers a new theme for this host and applies it at once, so the next load has no flash', () => {
    const theme = {
      primary: '#1e40af',
      primaryForeground: '#ffffff',
      radius: 'sm',
      headingFont: 'source_sans',
    } as const;

    rememberTheme(theme);

    const stored = localStorage.getItem(`${THEME_STORAGE_PREFIX}${window.location.host}`);
    expect(JSON.parse(stored ?? 'null')).toEqual(theme);
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#1e40af');
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('0.25rem');
  });
});
