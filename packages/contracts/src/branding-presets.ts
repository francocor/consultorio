import { DEFAULT_BRANDING, type BrandingFont, type BrandingRadius } from './branding.js';

/**
 * Ready-made looks for an organization. The product's own default is the neutral teal; "Aillu"
 * is the look of the demo organization and shows what per-organization theming can do. The server
 * still adjusts any color below WCAG 4.5:1, so a preset can never ship an unreadable theme.
 */
export interface BrandingPreset {
  id: string;
  displayName: string;
  shortName: string;
  primaryColor: string;
  radius: BrandingRadius;
  headingFont: BrandingFont;
}

export const BRANDING_PRESETS = [
  {
    id: 'consultorio',
    displayName: 'Consultorio',
    shortName: 'Consultorio',
    primaryColor: DEFAULT_BRANDING.primaryColor,
    radius: DEFAULT_BRANDING.radius,
    headingFont: DEFAULT_BRANDING.headingFont,
  },
  {
    id: 'aillu',
    displayName: 'Centro Médico Aillu',
    shortName: 'Aillu',
    primaryColor: '#03a550',
    radius: 'lg',
    headingFont: 'poppins',
  },
  {
    id: 'norte',
    displayName: 'Clínica Norte',
    shortName: 'Norte',
    primaryColor: '#1e40af',
    radius: 'sm',
    headingFont: 'source_sans',
  },
  {
    id: 'sur',
    displayName: 'Instituto del Sur',
    shortName: 'Sur',
    primaryColor: '#9a3412',
    radius: 'xl',
    headingFont: 'lora',
  },
] as const satisfies readonly BrandingPreset[];

export type BrandingPresetId = (typeof BRANDING_PRESETS)[number]['id'];

/** The look of the demo organization (see `docs/demo.md`). */
export const AILLU_PRESET = BRANDING_PRESETS[1];
