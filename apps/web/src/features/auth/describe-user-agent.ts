export interface DeviceDescription {
  browser: string;
  os: string;
}

const BROWSERS: readonly [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/Firefox\//, 'Firefox'],
  [/(?:Chrome|CriOS)\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux|X11/, 'Linux'],
];

/**
 * A readable browser and system from a `User-Agent`, for the list of open sessions. It only
 * recognizes the common ones and returns null rather than guessing.
 */
export function describeUserAgent(userAgent: string | null): DeviceDescription | null {
  if (!userAgent) return null;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return browser && os ? { browser, os } : null;
}
