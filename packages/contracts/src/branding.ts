import { z } from 'zod';

/**
 * Contracts of tenant branding: the name, colors, corner radius and heading font of an
 * organization, and the public payload that draws its sign-in screen and shell. Nothing here
 * carries personal data, and nothing is hardcoded to a customer.
 */

/** Corner radius steps of the design system. */
export const BRANDING_RADII = ['none', 'sm', 'md', 'lg', 'xl'] as const;
export type BrandingRadius = (typeof BRANDING_RADII)[number];

/** A curated set, so every choice is a font the product ships and has checked for legibility. */
export const BRANDING_FONTS = ['inter', 'source_sans', 'poppins', 'lora', 'merriweather'] as const;
export type BrandingFont = (typeof BRANDING_FONTS)[number];

export const DEFAULT_BRANDING = {
  primaryColor: '#0f766e',
  radius: 'md',
  headingFont: 'inter',
} as const satisfies { primaryColor: string; radius: BrandingRadius; headingFont: BrandingFont };

const HexColor = z.string().regex(/^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'expected a hex color');

/** Saves the whole identity. The name is the organization's, shown in the shell, emails and PDFs. */
export const UpdateBrandingRequest = z.strictObject({
  displayName: z.string().trim().min(1).max(60),
  shortName: z.string().trim().min(1).max(16),
  primaryColor: HexColor,
  radius: z.enum(BRANDING_RADII),
  headingFont: z.enum(BRANDING_FONTS),
});
export type UpdateBrandingRequest = z.infer<typeof UpdateBrandingRequest>;

/** Asks what a color will look like once made accessible, before saving it. */
export const BrandingPreviewRequest = z.strictObject({ primaryColor: HexColor });
export type BrandingPreviewRequest = z.infer<typeof BrandingPreviewRequest>;

export const ContrastResultDto = z.strictObject({
  requested: z.string(),
  effective: z.string(),
  foreground: z.string(),
  adjusted: z.boolean(),
  ratio: z.number(),
  warning: z.literal('branding.contrast_adjusted').nullable(),
});
export type ContrastResultDto = z.infer<typeof ContrastResultDto>;

export const BrandingDto = z.strictObject({
  /** Null until the organization sets one: the neutral product default is shown instead. */
  displayName: z.string().nullable(),
  shortName: z.string().nullable(),
  /** The color the admin chose, kept as chosen. */
  primaryRequested: z.string(),
  /** The color used for text and controls: the requested one, or its accessible variant. */
  primaryEffective: z.string(),
  primaryForeground: z.string(),
  radius: z.enum(BRANDING_RADII),
  headingFont: z.enum(BRANDING_FONTS),
  /** Where the logo is served from, or null when the organization has none. */
  logoUrl: z.string().nullable(),
});
export type BrandingDto = z.infer<typeof BrandingDto>;

export const BrandingResponse = z.strictObject({
  branding: BrandingDto,
  contrast: ContrastResultDto,
});
export type BrandingResponse = z.infer<typeof BrandingResponse>;

/** Logo limits, shared by the screen (to warn early) and the server (to enforce). */
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_DIMENSION = 2048;
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

// The public payload ----------------------------------------------------------------------------

/**
 * What an unauthenticated visitor of a tenant's host receives to draw the sign-in screen and the
 * installable app: whitelisted keys only, no personal data and nothing about other tenants.
 */
export const BootPayload = z.strictObject({
  name: z.string(),
  shortName: z.string(),
  theme: z.strictObject({
    primary: z.string(),
    primaryForeground: z.string(),
    radius: z.enum(BRANDING_RADII),
    headingFont: z.enum(BRANDING_FONTS),
  }),
  logoUrl: z.string().nullable(),
  locale: z.string(),
  /** Feature flags that are on for this organization. */
  features: z.array(z.string()),
  deploymentMode: z.enum(['multi', 'single']),
  /** Demo organizations show a banner; the flag is fixed when the organization is created. */
  isDemo: z.boolean(),
  /**
   * Which providers of this deployment run on a local simulator (Stages 3 to 6). A screen that
   * shows what a simulator produced says so: `afip` marks the invoices as test documents and `erx`
   * the prescriptions (Stage 5; absent means no, so a payload built before it still parses). Only
   * yes or no per provider; the deployment's settings never travel.
   */
  localProviders: z.strictObject({ afip: z.boolean(), erx: z.boolean().optional() }),
});
export type BootPayload = z.infer<typeof BootPayload>;

export const WebManifest = z.object({
  name: z.string(),
  short_name: z.string(),
  start_url: z.string(),
  scope: z.string(),
  display: z.literal('standalone'),
  lang: z.string(),
  theme_color: z.string(),
  background_color: z.string(),
  icons: z.array(
    z.object({ src: z.string(), sizes: z.string(), type: z.string(), purpose: z.string() }),
  ),
});
export type WebManifest = z.infer<typeof WebManifest>;
