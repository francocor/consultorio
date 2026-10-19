import { describe, expect, it } from 'vitest';

import { CreateExportRequest, EXPORT_KINDS, EXPORT_STATUSES } from './billing.js';

const PLACE = '0190a000-0000-7000-8000-0000000000e1';

describe('the export request', () => {
  const valid = { kind: 'charges', format: 'csv', from: '2031-05-01', to: '2031-05-31' };

  it('names what, in which format and for which days, optionally one place, professional or payer', () => {
    expect(CreateExportRequest.parse(valid)).toEqual(valid);
    expect(
      CreateExportRequest.parse({
        ...valid,
        kind: 'payer_settlement',
        format: 'xlsx',
        locationId: PLACE,
      }),
    ).toMatchObject({ kind: 'payer_settlement', format: 'xlsx', locationId: PLACE });
  });

  it('knows three kinds and four states', () => {
    expect([...EXPORT_KINDS]).toEqual(['charges', 'payments', 'payer_settlement']);
    expect([...EXPORT_STATUSES]).toEqual(['queued', 'ready', 'empty', 'failed']);
  });

  it('refuses a kind or format it cannot make, a reversed period and a period over a year', () => {
    expect(CreateExportRequest.safeParse({ ...valid, kind: 'clinical_notes' }).success).toBe(false);
    expect(CreateExportRequest.safeParse({ ...valid, format: 'docx' }).success).toBe(false);
    expect(CreateExportRequest.safeParse({ ...valid, from: '2031-06-01' }).success).toBe(false);
    expect(
      CreateExportRequest.safeParse({ ...valid, from: '2030-01-01', to: '2031-05-31' }).success,
    ).toBe(false);
    expect(CreateExportRequest.safeParse({ ...valid, from: '2031-05-1' }).success).toBe(false);
  });

  it('refuses unknown fields, so the scope cannot be sent by the client', () => {
    expect(CreateExportRequest.safeParse({ ...valid, scope: { kind: 'all' } }).success).toBe(false);
    expect(CreateExportRequest.safeParse({ ...valid, tenantId: PLACE }).success).toBe(false);
  });
});
