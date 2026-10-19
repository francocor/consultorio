import {
  CashSessionDetailResponse,
  CashSessionDto,
  CashSessionListResponse,
  ChargeDto,
  ChargeListResponse,
  DownloadLinkResponse,
  ExportRequestDto,
  ExportRequestListResponse,
  PayerListResponse,
  PaymentResultResponse,
  PriceListResponse,
  PayerPriceDto,
  PriceDto,
  PriceQuoteResponse,
  ReceivablesResponse,
  TenantPayerDto,
  type AddChargeLineRequest,
  type CashCloseRequest,
  type CashOpenRequest,
  type CaptureChargeRequest,
  type ChargeStatus,
  type CorrectPaymentRequest,
  type CreateExportRequest,
  type CreatePayerPriceRequest,
  type CreatePriceRequest,
  type CreateTenantPayerRequest,
  type RecordPaymentRequest,
  type RefundPaymentRequest,
  type UpdatePayerPriceRequest,
  type UpdatePriceRequest,
  type UpdateTenantPayerRequest,
  type VoidChargeRequest,
} from '@consultorio/contracts';
import { z } from 'zod';

import type { ApiClient } from '../../../shared/lib/api-client.js';

const CurrentCash = z.object({ session: CashSessionDto.nullable() });

export interface ChargeFilters {
  appointmentId?: string | undefined;
  patientId?: string | undefined;
  status?: ChargeStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  needsReview?: boolean | undefined;
}

export interface QuoteChoice {
  /** `private`, or the id of a payer of the list; absent: the coverage of the patient decides. */
  payer?: string | undefined;
  planName?: string | undefined;
}

export const billingKeys = {
  all: ['billing'] as const,
  charges: (filters: ChargeFilters) => ['billing', 'charges', filters] as const,
  chargesOf: (appointmentId: string) => ['billing', 'charges', { appointmentId }] as const,
  quote: (appointmentId: string, choice: QuoteChoice) =>
    ['billing', 'quote', appointmentId, choice] as const,
  payers: ['billing', 'payers'] as const,
  prices: ['billing', 'prices'] as const,
  receivables: (from: string | undefined, to: string | undefined) =>
    ['billing', 'receivables', from, to] as const,
  exports: ['billing', 'exports'] as const,
  cashCurrent: (locationId: string) => ['billing', 'cash', 'current', locationId] as const,
  cashSession: (id: string) => ['billing', 'cash', 'session', id] as const,
  cashList: (locationId: string) => ['billing', 'cash', 'list', locationId] as const,
};

/** What the billing and cash screens ask of the API. */
export function billingApi(api: ApiClient) {
  return {
    // Charges ------------------------------------------------------------------------------
    charges: (filters: ChargeFilters = {}) =>
      api.get('/billing/charges', {
        query: {
          ...filters,
          needsReview: filters.needsReview === undefined ? undefined : String(filters.needsReview),
        },
        schema: ChargeListResponse,
      }),
    charge: (chargeId: string) => api.get(`/billing/charges/${chargeId}`, { schema: ChargeDto }),
    quote: (appointmentId: string, choice: QuoteChoice = {}) =>
      api.get('/billing/price-quote', {
        query: { appointmentId, ...choice },
        schema: PriceQuoteResponse,
      }),
    capture: (body: CaptureChargeRequest) =>
      api.post('/billing/charges', { body, schema: ChargeDto }),
    addLine: (chargeId: string, body: AddChargeLineRequest) =>
      api.post(`/billing/charges/${chargeId}/lines`, { body, schema: ChargeDto }),
    voidCharge: (chargeId: string, body: VoidChargeRequest) =>
      api.post(`/billing/charges/${chargeId}/void`, { body, schema: ChargeDto }),

    // Payments -----------------------------------------------------------------------------
    pay: (chargeId: string, body: RecordPaymentRequest) =>
      api.post(`/billing/charges/${chargeId}/payments`, { body, schema: PaymentResultResponse }),
    refund: (paymentId: string, body: RefundPaymentRequest) =>
      api.post(`/billing/payments/${paymentId}/refund`, { body, schema: PaymentResultResponse }),
    correct: (paymentId: string, body: CorrectPaymentRequest) =>
      api.post(`/billing/payments/${paymentId}/correct`, { body, schema: PaymentResultResponse }),
    receivables: (from?: string, to?: string) =>
      api.get('/billing/receivables', { query: { from, to }, schema: ReceivablesResponse }),

    // Payers and prices --------------------------------------------------------------------
    payers: () => api.get('/billing/payers', { schema: PayerListResponse }),
    addPayer: (body: CreateTenantPayerRequest) =>
      api.post('/billing/payers', { body, schema: TenantPayerDto }),
    updatePayer: (id: string, body: UpdateTenantPayerRequest) =>
      api.patch(`/billing/payers/${id}`, { body, schema: TenantPayerDto }),
    prices: () => api.get('/billing/prices', { schema: PriceListResponse }),
    addPrice: (body: CreatePriceRequest) => api.post('/billing/prices', { body, schema: PriceDto }),
    updatePrice: (id: string, body: UpdatePriceRequest) =>
      api.patch(`/billing/prices/${id}`, { body, schema: PriceDto }),
    addPayerPrice: (body: CreatePayerPriceRequest) =>
      api.post('/billing/payer-prices', { body, schema: PayerPriceDto }),
    updatePayerPrice: (id: string, body: UpdatePayerPriceRequest) =>
      api.patch(`/billing/payer-prices/${id}`, { body, schema: PayerPriceDto }),

    // Exports ------------------------------------------------------------------------------
    requestExport: (body: CreateExportRequest) =>
      api.post('/billing/exports', { body, schema: ExportRequestDto }),
    exports: () => api.get('/billing/exports', { schema: ExportRequestListResponse }),
    exportStatus: (id: string) => api.get(`/billing/exports/${id}`, { schema: ExportRequestDto }),
    /** Asks for a link and follows it with this session: the file arrives as a blob. */
    downloadExport: async (id: string) => {
      const link = await api.post(`/billing/exports/${id}/download`, {
        schema: DownloadLinkResponse,
      });
      return api.download(link.url);
    },

    // Cash register ------------------------------------------------------------------------
    cashCurrent: (locationId: string) =>
      api.get('/billing/cash/current', { query: { locationId }, schema: CurrentCash }),
    cashSessions: (locationId: string, status?: 'open' | 'closed') =>
      api.get('/billing/cash/sessions', {
        query: { locationId, status },
        schema: CashSessionListResponse,
      }),
    cashSession: (id: string) =>
      api.get(`/billing/cash/sessions/${id}`, { schema: CashSessionDetailResponse }),
    openCash: (body: CashOpenRequest) =>
      api.post('/billing/cash/sessions', { body, schema: CashSessionDto }),
    closeCash: (id: string, body: CashCloseRequest) =>
      api.post(`/billing/cash/sessions/${id}/close`, { body, schema: CashSessionDto }),
  };
}
