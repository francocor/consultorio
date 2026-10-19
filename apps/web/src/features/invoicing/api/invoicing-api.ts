import {
  CredentialSummaryDto,
  DownloadLinkResponse,
  FiscalConfigResponse,
  FiscalProfileDto,
  InvoiceDto,
  InvoiceListResponse,
  InvoicingOptionsDto,
  InvoicingReadinessDto,
  PointOfSaleDto,
  SettingsDto,
  type CreateCreditNoteRequest,
  type CreateInvoiceRequest,
  type CreateManualInvoiceRequest,
  type CreatePointOfSaleRequest,
  type InvoiceStatus,
  type PutCredentialRequest,
  type UpdatePointOfSaleRequest,
  type UpsertFiscalProfileRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export interface InvoiceFilters {
  status?: InvoiceStatus | undefined;
  /** The invoices that cover a line of this charge. */
  chargeId?: string | undefined;
  /** The credit notes of this invoice. */
  creditNoteOfId?: string | undefined;
}

export const invoicingKeys = {
  config: ['invoicing', 'config'] as const,
  /** The organization settings, which hold the e-invoicing switch (the settings feature's key). */
  settings: ['settings'] as const,
  all: ['invoicing', 'invoices'] as const,
  invoices: (filters: InvoiceFilters) => ['invoicing', 'invoices', 'list', filters] as const,
  invoice: (id: string) => ['invoicing', 'invoices', 'one', id] as const,
  options: ['invoicing', 'options'] as const,
  readiness: ['invoicing', 'readiness'] as const,
};

/** What the invoicing screens ask of the API. */
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

    // Issuing --------------------------------------------------------------------------------
    readiness: () => api.get('/invoicing/readiness', { schema: InvoicingReadinessDto }),
    options: () => api.get('/invoicing/options', { schema: InvoicingOptionsDto }),
    invoices: (filters: InvoiceFilters = {}) =>
      api.get('/invoices', { query: { ...filters }, schema: InvoiceListResponse }),
    invoice: (id: string) => api.get(`/invoices/${id}`, { schema: InvoiceDto }),
    createInvoice: (body: CreateInvoiceRequest) =>
      api.post('/invoices', { body, schema: InvoiceDto }),
    createCreditNote: (invoiceId: string, body: CreateCreditNoteRequest) =>
      api.post(`/invoices/${invoiceId}/credit-notes`, { body, schema: InvoiceDto }),
    registerManual: (body: CreateManualInvoiceRequest) =>
      api.post('/invoices/manual', { body, schema: InvoiceDto }),
    /** Asks for a link and follows it with this session: the PDF arrives as a blob. */
    downloadPdf: async (invoiceId: string) => {
      const link = await api.get(`/invoices/${invoiceId}/pdf-link`, {
        schema: DownloadLinkResponse,
      });
      return api.download(link.url);
    },
  };
}
