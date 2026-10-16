import {
  BrandingResponse,
  ContrastResultDto,
  type UpdateBrandingRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const brandingKeys = {
  all: ['branding'] as const,
  preview: (color: string) => ['branding', 'preview', color] as const,
};

/** The branding module of the API: identity, color check and logo. */
export function brandingApi(api: ApiClient) {
  return {
    get: () => api.get('/branding', { schema: BrandingResponse }),
    update: (body: UpdateBrandingRequest) =>
      api.put('/branding', { body, schema: BrandingResponse }),
    /** What a color will look like once made accessible. Nothing is saved. */
    preview: (primaryColor: string) =>
      api.post('/branding/preview', { body: { primaryColor }, schema: ContrastResultDto }),
    uploadLogo: (file: File) =>
      api.upload('PUT', '/branding/logo', file, { schema: BrandingResponse }),
    removeLogo: () => api.delete('/branding/logo', { schema: BrandingResponse }),
  };
}
