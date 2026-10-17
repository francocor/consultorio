import { useSyncExternalStore } from 'react';

/** Whether a CSS media query matches right now, and keeps matching as the window changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => {
        list.removeEventListener('change', notify);
      };
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** From the tablet breakpoint of the design system (`md`, 768 px) up. */
export const WIDE_SCREEN = '(min-width: 768px)';

export function useIsWideScreen(): boolean {
  return useMediaQuery(WIDE_SCREEN);
}
