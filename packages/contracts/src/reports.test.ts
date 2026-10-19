import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  CashReportFilters,
  CashReportResponse,
  FINANCIAL_RECORD_KINDS,
  FinancialFilters,
  FinancialRecordsQuery,
  FinancialRecordsResponse,
  FinancialReportResponse,
  OperationalReportResponse,
  REPORTS_AUDIT_ACTIONS,
  REPORTS_ERRORS,
  REPORT_GROUPS,
  REPORT_MAX_SPAN_DAYS,
  ReportFilters,
  ReportOptionsResponse,
  ReportRecordsQuery,
  ReportRecordsResponse,
} from './reports.js';
import { APPOINTMENT_STATUSES } from './scheduling.js';

const ID = '0190a000-0000-7000-8000-000000000001';

function counts(overrides: Partial<Record<(typeof APPOINTMENT_STATUSES)[number], number>> = {}) {
  return Object.fromEntries(
    APPOINTMENT_STATUSES.map((status) => [status, overrides[status] ?? 0]),
  ) as Record<(typeof APPOINTMENT_STATUSES)[number], number>;
}

const row = { total: 4, attended: 2, noShow: 1, cancelled: 1, noShowRateBp: 3333 };

function report() {
  return {
    filters: {
      from: '2031-05-01',
      to: '2031-05-31',
      locationId: null,
      professionalId: null,
      specialty: null,
      scope: 'organization' as const,
    },
    generatedAt: '2031-06-01T12:00:00.000Z',
    totalAppointments: 4,
    byStatus: counts({ attended: 2, no_show: 1, cancelled: 1 }),
    noShow: {
      attended: 2,
      noShow: 1,
      rateBp: 3333 as number | null,
      excluded: { cancelled: 1, notFinal: 0, notFinalPast: 0 },
    },
    occupancy: { bookedMinutes: 90, availableMinutes: 240, rateBp: 3750 as number | null },
    patients: { new: 3, returning: 1 },
    rescheduled: 1,
    sources: { staff: 3, online: 1, waitlistOffer: 0, onlineShareBp: 2500 },
    waitlist: { recoveredSlots: 0 },
    confirmations: { confirmedByPatient: 1, rateBp: 3333 },
    byDay: [{ date: '2031-05-12', ...row }],
    byLocation: [{ locationId: ID, name: 'Centro', ...row }],
    byProfessional: [{ professionalId: ID, name: 'Dra. Paz', ...row }],
    bySpecialty: [{ specialty: 'clinica', ...row }],
  };
}

describe('reports catalogues', () => {
  it('limits a report to a span of 366 days (the range filter rejects more)', () => {
    expect(REPORT_MAX_SPAN_DAYS).toBe(366);
  });

  it('registers its audit action in the shared catalogue', () => {
    expect(REPORTS_AUDIT_ACTIONS).toEqual(['report.accessed']);
    for (const action of REPORTS_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('needs no error codes of its own: a bad filter is a validation error and a scope refusal is the uniform 403', () => {
    expect(Object.keys(REPORTS_ERRORS)).toEqual([]);
  });
});

describe('ReportFilters', () => {
  it('reads a date range and the optional narrowing filters', () => {
    expect(
      ReportFilters.parse({
        from: '2031-05-01',
        to: '2031-05-31',
        locationId: ID,
        professionalId: ID,
        specialty: ' clinica ',
      }),
    ).toEqual({
      from: '2031-05-01',
      to: '2031-05-31',
      locationId: ID,
      professionalId: ID,
      specialty: 'clinica',
    });
  });

  it('ignores an organization id that rides along in the query (tenancy comes from the session)', () => {
    const parsed = ReportFilters.parse({
      from: '2031-05-01',
      to: '2031-05-31',
      tenantId: ID,
      tenant_id: ID,
    });

    expect(parsed).toEqual({ from: '2031-05-01', to: '2031-05-31' });
  });

  it.each([
    ['a missing range', {}],
    ['a date that does not exist', { from: '2031-02-30', to: '2031-03-01' }],
    ['a location that is not an id', { from: '2031-05-01', to: '2031-05-31', locationId: 'x' }],
    ['an empty specialty', { from: '2031-05-01', to: '2031-05-31', specialty: '  ' }],
  ])('rejects %s', (_label, query) => {
    expect(ReportFilters.safeParse(query).success).toBe(false);
  });
});

describe('ReportRecordsQuery', () => {
  const base = { from: '2031-05-01', to: '2031-05-31' };

  it('defaults to the whole period, first page of 50', () => {
    expect(ReportRecordsQuery.parse(base)).toMatchObject({ group: 'all', limit: 50, offset: 0 });
  });

  it('accepts every appointment status as a group, plus the derived ones', () => {
    for (const group of REPORT_GROUPS) {
      expect(ReportRecordsQuery.parse({ ...base, group }).group).toBe(group);
    }
    expect(REPORT_GROUPS).toEqual([
      'all',
      ...APPOINTMENT_STATUSES,
      'rescheduled',
      'online',
      'recovered',
    ]);
  });

  it('coerces the page from the query string and caps it', () => {
    expect(ReportRecordsQuery.parse({ ...base, limit: '25', offset: '50' })).toMatchObject({
      limit: 25,
      offset: 50,
    });
    expect(ReportRecordsQuery.safeParse({ ...base, limit: '500' }).success).toBe(false);
    expect(ReportRecordsQuery.safeParse({ ...base, group: 'paid' }).success).toBe(false);
  });
});

describe('OperationalReportResponse', () => {
  it('accepts a full report', () => {
    expect(OperationalReportResponse.parse(report())).toMatchObject({
      totalAppointments: 4,
      noShow: { rateBp: 3333 },
    });
  });

  it('allows a rate to be absent when there is nothing to divide', () => {
    const empty = report();
    empty.noShow = { ...empty.noShow, attended: 0, noShow: 0, rateBp: null };
    empty.occupancy = { ...empty.occupancy, availableMinutes: 0, rateBp: null };

    const parsed = OperationalReportResponse.parse(empty);

    expect(parsed.noShow.rateBp).toBeNull();
    expect(parsed.occupancy.rateBp).toBeNull();
  });

  it('has no field for clinical content: an extra one is refused', () => {
    expect(OperationalReportResponse.safeParse({ ...report(), diagnosis: 'x' }).success).toBe(
      false,
    );
  });

  it('requires all eight statuses in the counts', () => {
    const missing = report();
    delete (missing.byStatus as Partial<typeof missing.byStatus>).no_show;

    expect(OperationalReportResponse.safeParse(missing).success).toBe(false);
  });
});

describe('ReportRecordsResponse', () => {
  it('carries identification and administrative columns only', () => {
    const record = {
      appointmentId: ID,
      startsAt: '2031-05-12T13:00:00.000Z',
      localDate: '2031-05-12',
      localTime: '10:00',
      status: 'attended' as const,
      source: 'online' as const,
      rescheduled: false,
      patientId: ID,
      patientName: 'Pérez, Ana',
      locationId: ID,
      locationName: 'Centro',
      professionalId: ID,
      professionalName: 'Dra. Paz',
      appointmentTypeName: 'Consulta',
    };
    const response = {
      filters: report().filters,
      group: 'all' as const,
      total: 1,
      limit: 50,
      offset: 0,
      records: [record],
    };

    expect(ReportRecordsResponse.parse(response).records[0]).toEqual(record);
    expect(
      ReportRecordsResponse.safeParse({
        ...response,
        records: [{ ...record, note: 'free text' }],
      }).success,
    ).toBe(false);
  });
});

describe('ReportOptionsResponse', () => {
  it('lists what the viewer may filter by and whether revenue by professional is theirs to see', () => {
    const options = {
      scope: 'locations' as const,
      locations: [{ id: ID, name: 'Centro' }],
      professionals: [{ id: ID, name: 'Dra. Paz' }],
      specialties: ['clinica'],
      payers: [{ id: ID, name: 'OSDE' }],
      canSeeRevenueByProfessional: false,
      canSeeCashReport: true,
      maxSpanDays: 366,
    };

    expect(ReportOptionsResponse.parse(options)).toEqual(options);
  });
});

const FINANCIAL_FILTERS = {
  from: '2031-05-01',
  to: '2031-05-31',
  locationId: null,
  professionalId: null,
  tenantPayerId: null,
  scope: 'organization' as const,
};

const MONEY_ROW = {
  key: 'x',
  label: null as string | null,
  chargedCents: 10_000_000,
  voidedCents: 2_000_000,
  paymentsCents: 6_000_000,
  refundsCents: 500_000,
  collectedCents: 5_500_000,
  outstandingCents: 1_000_000,
  receivableCents: 3_000_000,
  invoicedNetCents: 8_000_000 as number | null,
};

const METHOD_ROW = {
  method: 'cash' as const,
  count: 4,
  paymentsCents: 6_000_000,
  refundsCents: 500_000,
  netCents: 5_500_000,
};

function financial() {
  return {
    filters: FINANCIAL_FILTERS,
    generatedAt: '2031-06-01T12:00:00.000Z',
    totals: {
      charged: { count: 4, totalCents: 10_000_000, patientCents: 7_000_000, payerCents: 3_000_000 },
      voided: { count: 1, totalCents: 2_000_000 },
      collected: {
        paymentCount: 3,
        paymentsCents: 6_000_000,
        refundCount: 1,
        refundsCents: 500_000,
        netCents: 5_500_000,
      },
      outstanding: { chargeCount: 2, cents: 1_000_000 },
      receivable: { cents: 3_000_000 },
      invoiced: {
        invoicedCents: 10_000_000,
        creditedCents: 2_000_000,
        netCents: 8_000_000,
        documents: 3,
      },
    },
    byMethod: [METHOD_ROW],
    byPeriod: [{ ...MONEY_ROW, key: '2031-05-12' }],
    byLocation: [{ ...MONEY_ROW, key: ID, label: 'Centro' }],
    byProfessional: [{ ...MONEY_ROW, key: ID, label: 'Dra. Paz' }] as (typeof MONEY_ROW)[] | null,
    byPayer: [{ ...MONEY_ROW, key: 'private', label: null }],
    byType: [{ ...MONEY_ROW, key: 'Consulta', invoicedNetCents: null }],
  };
}

describe('FinancialFilters', () => {
  it('takes the period, the place, the professional and the payer, and ignores what else is sent', () => {
    const parsed = FinancialFilters.parse({
      from: '2031-05-01',
      to: '2031-05-31',
      locationId: ID,
      tenantPayerId: ID,
      tenantId: '0190a000-0000-7000-8000-0000000000ff',
      specialty: 'clinica',
    });

    expect(parsed).toEqual({
      from: '2031-05-01',
      to: '2031-05-31',
      locationId: ID,
      tenantPayerId: ID,
    });
  });

  it('refuses a day that is not a date and an id that is not an id', () => {
    expect(FinancialFilters.safeParse({ from: '01/05/2031', to: '2031-05-31' }).success).toBe(
      false,
    );
    expect(
      FinancialFilters.safeParse({ from: '2031-05-01', to: '2031-05-31', tenantPayerId: 'osde' })
        .success,
    ).toBe(false);
  });
});

describe('FinancialReportResponse', () => {
  it('carries whole cents, signed where a reduction is a figure, and nothing clinical', () => {
    expect(FinancialReportResponse.parse(financial()).totals.invoiced.netCents).toBe(8_000_000);
  });

  it('refuses a fraction of a cent anywhere in the figures', () => {
    const response = financial();
    response.totals.charged.totalCents = 10_000_000.5;

    expect(FinancialReportResponse.safeParse(response).success).toBe(false);
  });

  it('is null in the breakdown by professional when the viewer may not see revenue by professional', () => {
    const response = { ...financial(), byProfessional: null };

    expect(FinancialReportResponse.parse(response).byProfessional).toBeNull();
  });

  it('refuses a member it does not know (a note, a diagnosis)', () => {
    expect(FinancialReportResponse.safeParse({ ...financial(), diagnosis: 'x' }).success).toBe(
      false,
    );
  });
});

describe('financial drill-down', () => {
  it('lists six kinds of records, one for each figure that can be opened', () => {
    expect(FINANCIAL_RECORD_KINDS).toEqual([
      'charged',
      'voided',
      'collected',
      'outstanding',
      'receivable',
      'invoiced',
    ]);
  });

  it('pages 50 records of the charged kind unless asked otherwise, and at most 200', () => {
    const query = FinancialRecordsQuery.parse({ from: '2031-05-01', to: '2031-05-31' });

    expect(query).toMatchObject({ kind: 'charged', limit: 50, offset: 0 });
    expect(
      FinancialRecordsQuery.safeParse({ from: '2031-05-01', to: '2031-05-31', limit: '201' })
        .success,
    ).toBe(false);
  });

  it('answers with the sum of the whole kind next to the page, and only administrative columns', () => {
    const record = {
      id: ID,
      date: '2031-05-12',
      patientName: 'Pérez, Ana',
      locationId: ID,
      locationName: 'Centro',
      professionalId: ID,
      professionalName: 'Dra. Paz',
      payerName: null,
      typeName: 'Consulta',
      status: 'paid',
      method: null,
      amountCents: 2_000_000,
      chargeTotalCents: 2_000_000,
    };
    const response = {
      filters: FINANCIAL_FILTERS,
      kind: 'charged' as const,
      total: 1,
      sumCents: 2_000_000,
      limit: 50,
      offset: 0,
      records: [record],
    };

    expect(FinancialRecordsResponse.parse(response).records[0]).toEqual(record);
    expect(
      FinancialRecordsResponse.safeParse({ ...response, records: [{ ...record, note: 'x' }] })
        .success,
    ).toBe(false);
  });
});

describe('cash report', () => {
  it('takes a period and one place, and ignores the rest', () => {
    expect(
      CashReportFilters.parse({
        from: '2031-05-01',
        to: '2031-05-31',
        locationId: ID,
        tenantId: ID,
      }),
    ).toEqual({ from: '2031-05-01', to: '2031-05-31', locationId: ID });
  });

  it('shows the difference of a day together with its reason', () => {
    const session = {
      id: ID,
      status: 'closed' as const,
      openedAt: '2031-05-12T11:00:00.000Z',
      closedAt: '2031-05-12T20:00:00.000Z',
      openingCents: 1_000_000,
      expectedCents: 3_000_000,
      countedCents: 2_900_000,
      differenceCents: -100_000,
      differenceReason: 'Vuelto mal dado',
    };
    const method = { ...METHOD_ROW, paymentsCents: 2_500_000, netCents: 2_000_000 };
    const response = {
      filters: {
        from: '2031-05-01',
        to: '2031-05-31',
        locationId: null,
        scope: 'organization' as const,
      },
      generatedAt: '2031-06-01T12:00:00.000Z',
      totals: {
        openingCents: 1_000_000,
        paymentsCents: 2_500_000,
        refundsCents: 500_000,
        expectedCents: 3_000_000,
        countedCents: 2_900_000 as number | null,
        differenceCents: -100_000 as number | null,
        daysWithDifference: 1,
        byMethod: [method],
      },
      days: [
        {
          date: '2031-05-12',
          locationId: ID,
          locationName: 'Centro',
          openingCents: 1_000_000,
          paymentsCents: 2_500_000,
          refundsCents: 500_000,
          expectedCents: 3_000_000,
          countedCents: 2_900_000 as number | null,
          differenceCents: -100_000 as number | null,
          openSessions: 0,
          closedSessions: 1,
          byMethod: [method],
          sessions: [session],
        },
      ],
    };

    const parsed = CashReportResponse.parse(response);

    expect(parsed.days[0]?.sessions[0]).toMatchObject({
      differenceCents: -100_000,
      differenceReason: 'Vuelto mal dado',
    });
    expect(
      CashReportResponse.safeParse({
        ...response,
        days: [{ ...response.days[0], openingCents: 10.5 }],
      }).success,
    ).toBe(false);
  });
});
