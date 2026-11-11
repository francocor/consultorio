/**
 * Accessible brand colors (tenant-branding, "Accessible color choices"; design section 7,
 * "Branding contrast"). The primary color of an organization is used behind white text and as a
 * link color on white, so it has to reach the WCAG 2.x AA ratio of 4.5:1 against white. When the
 * chosen color does not, the server does not reject it: it keeps what the admin chose
 * (`requested`) and computes the nearest color that passes (`effective`) by lowering the
 * perceptual lightness in OKLCH while holding hue and, as far as the gamut allows, chroma.
 */

/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;
const FOREGROUND = '#ffffff';

export interface Oklch {
  l: number;
  c: number;
  /** Degrees, 0 to 360. */
  h: number;
}

export interface BrandContrast {
  requested: string;
  effective: string;
  /** Text and icons on the primary color. */
  foreground: typeof FOREGROUND;
  adjusted: boolean;
  /** Contrast ratio of `effective` against `foreground`. */
  ratio: number;
  /** An i18n key the web app shows next to the picker, or null when nothing was changed. */
  warning: 'branding.contrast_adjusted' | null;
}

/** `#rrggbb` in lower case from `#rgb`, `rgb`, `#rrggbb` or `rrggbb`; null for anything else. */
export function normalizeHex(input: string): string | null {
  if (typeof input !== 'string') return null;
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(input.trim());
  const digits = match?.[1];
  if (!digits) return null;
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits;
  return `#${full.toLowerCase()}`;
}

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors, 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const a = luminance(normalizeHex(first) ?? '#000000');
  const b = luminance(normalizeHex(second) ?? '#000000');
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** sRGB hex to OKLCH (Björn Ottosson's OKLab). */
export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = channels(normalizeHex(hex) ?? '#000000').map(toLinear) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, bb);
  const hue = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l: lightness, c: chroma, h: chroma < 1e-4 ? 0 : hue };
}

function linearFromOklch({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lPrime = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mPrime = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sPrime = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * lPrime - 3.3077115913 * mPrime + 0.2309699292 * sPrime,
    -1.2684380046 * lPrime + 2.6097574011 * mPrime - 0.3413193965 * sPrime,
    -0.0041960863 * lPrime - 0.7034186147 * mPrime + 1.707614701 * sPrime,
  ];
}

function inGamut(linear: readonly number[]): boolean {
  return linear.every((value) => value >= -0.0005 && value <= 1.0005);
}

function toHex(linear: readonly number[]): string {
  const [r, g, b] = linear.map((value) => Math.round(fromLinear(value) * 255));
  return `#${[r, g, b].map((channel) => (channel ?? 0).toString(16).padStart(2, '0')).join('')}`;
}

/** The color at this lightness and hue with the most chroma (up to `c`) that fits in sRGB. */
function inGamutHex(l: number, c: number, h: number): string {
  if (inGamut(linearFromOklch({ l, c, h }))) return toHex(linearFromOklch({ l, c, h }));
  let low = 0;
  let high = c;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    if (inGamut(linearFromOklch({ l, c: middle, h }))) low = middle;
    else high = middle;
  }
  return toHex(linearFromOklch({ l, c: low, h }));
}

/**
 * Makes the primary color accessible. A color that already reaches 4.5:1 against white is
 * returned as it is. Otherwise the lightness is lowered, by bisection, to the highest value that
 * passes (after rounding to 8 bits per channel), so the result is the closest passing color along
 * that path and not simply black.
 */
export function ensureAccessiblePrimary(input: string): BrandContrast {
  const requested = normalizeHex(input);
  if (requested === null) throw new Error('not a color');

  const ratio = contrastRatio(requested, FOREGROUND);
  if (ratio >= MIN_CONTRAST) {
    return {
      requested,
      effective: requested,
      foreground: FOREGROUND,
      adjusted: false,
      ratio,
      warning: null,
    };
  }

  const { l, c, h } = hexToOklch(requested);
  let low = 0;
  let high = l;
  for (let step = 0; step < 32; step += 1) {
    const middle = (low + high) / 2;
    if (contrastRatio(inGamutHex(middle, c, h), FOREGROUND) >= MIN_CONTRAST) low = middle;
    else high = middle;
  }
  // Rounding to 8 bits can land a hair under the limit: step down until it holds.
  let lightness = low;
  let effective = inGamutHex(lightness, c, h);
  for (
    let guard = 0;
    guard < 200 && contrastRatio(effective, FOREGROUND) < MIN_CONTRAST;
    guard += 1
  ) {
    lightness = Math.max(0, lightness - 0.002);
    effective = inGamutHex(lightness, c, h);
  }

  return {
    requested,
    effective,
    foreground: FOREGROUND,
    adjusted: effective !== requested,
    ratio: contrastRatio(effective, FOREGROUND),
    warning: effective !== requested ? 'branding.contrast_adjusted' : null,
  };
}
