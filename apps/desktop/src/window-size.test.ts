import { describe, expect, it } from 'vitest';

import { AUX_WINDOW, fitToWorkArea, MAIN_WINDOW } from './window-size.js';

describe('window size', () => {
  it('keeps the preferred size on a screen that has room for it', () => {
    expect(fitToWorkArea(MAIN_WINDOW, { width: 1920, height: 1040 })).toEqual(MAIN_WINDOW);
  });

  it('shrinks the main window to a laptop screen instead of hanging off the edge', () => {
    // A 1366 x 768 laptop leaves about 1366 x 728 once the taskbar is counted.
    const fitted = fitToWorkArea(MAIN_WINDOW, { width: 1366, height: 728 });

    expect(fitted.width).toBe(1360);
    expect(fitted.height).toBe(728);
    expect(fitted.minHeight).toBeLessThanOrEqual(728);
  });

  it('never asks for a minimum bigger than the screen', () => {
    // 1366 x 768 at 150 % scaling is about 910 x 480 in device-independent pixels.
    const fitted = fitToWorkArea(MAIN_WINDOW, { width: 910, height: 480 });

    expect(fitted).toMatchObject({ width: 910, height: 480, minWidth: 800, minHeight: 480 });
  });

  it('keeps the main window wide enough for the sidebar layout of the web app', () => {
    // The web app switches to the sidebar at 768 px (the `md` breakpoint).
    expect(MAIN_WINDOW.minWidth).toBeGreaterThanOrEqual(768);
  });

  it('lets the small windows (key, reset) shrink to a phone width, and no further', () => {
    expect(AUX_WINDOW.minWidth).toBe(360);
    expect(AUX_WINDOW.minHeight).toBeLessThanOrEqual(480);
    expect(fitToWorkArea(AUX_WINDOW, { width: 1920, height: 1040 })).toEqual(AUX_WINDOW);
  });
});
