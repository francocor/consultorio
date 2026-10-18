import {
  CredentialSummaryDto,
  FiscalConfigResponse,
  FiscalProfileDto,
  PointOfSaleDto,
  SettingsDto,
  type CreatePointOfSaleRequest,
  type PutCredentialRequest,
  type UpdatePointOfSaleRequest,
  type UpsertFiscalProfileRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const invoicingKeys = {
  config: ['invoicing', 'config'] as const,
  /** The organization settings, which hold the e-invoicing switch (the settings feature's key). */
  settings: ['settings'] as const,
};

/** What the fiscal settings screen asks of the API. */
export function invoicingApi(api: ApiClient) {
  return {
    config: () => api.get('/invoicing/config', { schema: FiscalConfigResponse }),
    saveProfile: (body: UpsertFiscalProfileRequest) =>
      api.put('/invoicing/profile', { body, schema: FiscalProfileDto }),
    addPointOfSale: (body: CreatePointOfSaleRequest) =>
      api.post('/invoicing/points-of-sale', { body, schema: PointOfSaleDto }),
    updatePointOfSale: (id: string, body: UpdatePointOfSaleRequest) =>
      api.patch(`/invoicing/points-of-sale/${id}`, { body, schema: PointOfSaleDto }),
    setEnabled: (enabled: boolean) =>
      api.patch('/settings', {
        body: { integrations: { einvoicing: enabled } },
        schema: SettingsDto,
      }),
    uploadCredential: (body: PutCredentialRequest) =>
      api.put('/invoicing/credentials', { body, schema: CredentialSummaryDto }),
  };
}
