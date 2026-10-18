import {
  money,
  type CashSessionDto,
  type ChargeDto,
  type PaymentDto,
} from '@consultorio/contracts';

/** Builders of the objects the billing screens read, for their tests. Whole cents everywhere. */

export const IDS = {
  charge: '0190a000-0000-7000-8000-0000000000c1',
  appointment: '0190a000-0000-7000-8000-0000000000a1',
  patient: '0190a000-0000-7000-8000-0000000000b1',
  professional: '0190a000-0000-7000-8000-0000000000d1',
  location: '0190a000-0000-7000-8000-0000000000e1',
  payment: '0190a000-0000-7000-8000-0000000000f1',
  session: '0190a000-0000-7000-8000-0000000000e9',
  user: '0190a000-0000-7000-8000-000000000001',
  payer: '0190a000-0000-7000-8000-0000000000aa',
};

export function payment(overrides: Partial<PaymentDto> = {}): PaymentDto {
  return {
    id: IDS.payment,
    chargeId: IDS.charge,
    method: 'cash',
    amountCents: money(400_000),
    creditCents: money(0),
    paidAt: '2031-05-12T13:10:00.000Z',
    recordedBy: IDS.user,
    externalRef: null,
    overrideReason: null,
    cashSessionId: IDS.session,
    correctsPaymentId: null,
    reversedCents: money(0),
    netCents: money(400_000),
    reversals: [],
    ...overrides,
  };
}

export function charge(overrides: Partial<ChargeDto> = {}): ChargeDto {
  return {
    id: IDS.charge,
    appointmentId: IDS.appointment,
    appointmentTypeName: 'Consulta',
    startsAt: '2031-05-12T13:00:00.000Z',
    patientId: IDS.patient,
    patientName: 'Lucía Fernández',
    professionalId: IDS.professional,
    professionalName: 'Dra. Ríos',
    locationId: IDS.location,
    locationName: 'Centro',
    tenantPayerId: null,
    payerName: null,
    planName: null,
    status: 'pending',
    explicitAmount: false,
    needsReview: false,
    reviewReason: null,
    flaggedAt: null,
    voidReason: null,
    voidedAt: null,
    lines: [
      {
        id: '0190a000-0000-7000-8000-0000000000c2',
        position: 1,
        kind: 'service',
        portion: 'patient',
        description: 'Consulta',
        amountCents: money(1_000_000),
        invoicedCents: money(0),
      },
    ],
    payments: [],
    totalCents: money(1_000_000),
    patientCents: money(1_000_000),
    payerCents: money(0),
    paidCents: money(0),
    outstandingCents: money(1_000_000),
    creditCents: money(0),
    invoicedCents: money(0),
    invoicing: 'not_invoiced',
    snapshot: {
      quote: null,
      explicitAmountCents: null,
      appointmentTypeName: 'Consulta',
      serviceDate: '2031-05-12',
    },
    capturedBy: IDS.user,
    capturedAt: '2031-05-12T12:55:00.000Z',
    ...overrides,
  };
}

export function session(overrides: Partial<CashSessionDto> = {}): CashSessionDto {
  return {
    id: IDS.session,
    locationId: IDS.location,
    locationName: 'Centro',
    status: 'open',
    openedAt: '2031-05-12T12:00:00.000Z',
    openedBy: IDS.user,
    openingCents: money(500_000),
    closedAt: null,
    closedBy: null,
    expectedCents: money(3_500_000),
    countedCents: null,
    differenceCents: null,
    differenceReason: null,
    cashInCents: money(3_000_000),
    cashOutCents: money(0),
    byMethod: [
      {
        method: 'cash',
        count: 2,
        paymentsCents: money(3_000_000),
        refundsCents: money(0),
        netCents: money(3_000_000),
      },
      {
        method: 'debit',
        count: 1,
        paymentsCents: money(1_234_50),
        refundsCents: money(0),
        netCents: money(1_234_50),
      },
    ],
    ...overrides,
  };
}
