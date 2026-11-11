/**
 * The size of the windows of the shell. Pure, so the rule can be tested without Electron: a window
 * never opens bigger than the free area of the screen (a 1366 x 768 laptop, once the taskbar and the
 * display scaling are counted, is smaller than the 1360 x 860 the program prefers), and the minimum
 * a person can drag it down to never exceeds that area either.
 */
export interface WindowSize {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

export interface WorkArea {
  width: number;
  height: number;
}

/**
 * The main window. 800 px wide keeps the web app in its sidebar layout (it starts at 768 px) and 560
 * px high leaves room for the header and a few rows.
 */
export const MAIN_WINDOW: WindowSize = { width: 1360, height: 860, minWidth: 800, minHeight: 560 };

/**
 * The small windows the shell opens itself (recovery key, password reset): one column of a form.
 * They can shrink to a phone width because their pages are laid out for one.
 */
export const AUX_WINDOW: WindowSize = { width: 560, height: 720, minWidth: 360, minHeight: 440 };

export function fitToWorkArea(size: WindowSize, area: WorkArea): WindowSize {
  const minWidth = Math.min(size.minWidth, area.width);
  const minHeight = Math.min(size.minHeight, area.height);
  return {
    width: Math.max(minWidth, Math.min(size.width, area.width)),
    height: Math.max(minHeight, Math.min(size.height, area.height)),
    minWidth,
    minHeight,
  };
}
