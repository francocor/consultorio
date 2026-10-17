/**
 * Stand-in for `virtual:pwa-register` in unit tests (the real module only exists in a Vite build).
 * It records how the app registered, and lets a test announce "a new version is waiting".
 */
export interface RegisterSWOptions {
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
}

let registration: RegisterSWOptions | undefined;
export const reloads: (boolean | undefined)[] = [];

export function registerSW(options: RegisterSWOptions = {}) {
  registration = options;
  return (reloadPage?: boolean): Promise<void> => {
    reloads.push(reloadPage);
    return Promise.resolve();
  };
}

/** What the app passed when it registered, or undefined if it never did. */
export function lastRegistration(): RegisterSWOptions | undefined {
  return registration;
}

export function resetRegistration(): void {
  registration = undefined;
  reloads.length = 0;
}
