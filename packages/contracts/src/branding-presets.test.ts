import { describe, expect, it } from 'vitest';

import { AILLU_PRESET, BRANDING_PRESETS } from './branding-presets.js';
import { DEFAULT_BRANDING, UpdateBrandingRequest } from './branding.js';

describe('branding presets', () => {
  it('every preset is a valid identity the API would accept', () => {
    for (const preset of BRANDING_PRESETS) {
      const identity = Object.fromEntries(Object.entries(preset).filter(([key]) => key !== 'id'));
      expect(UpdateBrandingRequest.safeParse(identity).success, preset.id).toBe(true);
    }
  });

  it('the first preset is the product default and Aillu is the legacy green with a heading font from the curated set', () => {
    expect(BRANDING_PRESETS[0].primaryColor).toBe(DEFAULT_BRANDING.primaryColor);
    expect(AILLU_PRESET).toMatchObject({
      id: 'aillu',
      primaryColor: '#03a550',
      headingFont: 'poppins',
    });
  });

  it('presets have distinct ids and colors', () => {
    expect(new Set(BRANDING_PRESETS.map((preset) => preset.id)).size).toBe(BRANDING_PRESETS.length);
    expect(new Set(BRANDING_PRESETS.map((preset) => preset.primaryColor)).size).toBe(
      BRANDING_PRESETS.length,
    );
  });
});
