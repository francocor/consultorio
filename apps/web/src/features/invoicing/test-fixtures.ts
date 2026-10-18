import {
  money,
  type ChargeDto,
  type InvoiceDto,
  type InvoicingOptionsDto,
} from '@consultorio/contracts';

/** Builders of the objects the invoicing screens read, for their tests. Whole cents everywhere. */

export const IDS = {
  invoice: '0190a000-0000-7000-8000-0000000000b1',
  charge: '0190a000-0000-7000-8000-0000000000c1',
  chargeLine: '0190a000-0000-7000-8000-0000000000c2',
  payerLine: '0190a000-0000-7000-8000-0000000000c3',
  invoiceLine: '0190a000-0000-7000-8000-0000000000d2',
  appointment: '0190a000-0000-7000-8000-0000000000a1',
  patient: '0190a000-0000-7000-8000-0000000000e1',
  professional: '0190a000-0000-7000-8000-0000000000f1',
  location: '0190a000-0000-7000-8000-0000000000f2',
  payer: '0190a000-0000-7000-8000-0000000000aa',
};

export function invoice(overrides: Partial<InvoiceDto> = {}): InvoiceDto {
  return {
    id: IDS.invoice,
    kind: 'invoice',
    type: 'FC',
    status: 'issued',
    pointOfSale: 1,
    number: 77,
    cae: '70123456789012',
    caeExpiresOn: '2031-05-30',
    issueDate: '2031-05-20',
    environment: 'homologation',
    simulated: true,
    testDocument: true,
    recipient: {
      kind: 'patient',
      patientId: IDS.patient,
      tenantPayerId: null,
      name: 'Lucía Fernández',
      taxCondition: 'consumidor_final',
      document: null,
    },
    totalCents: 2_000_000,
    netCents: 2_000_000,
    vatCents: 0,
    exemptCents: 0,
    creditNoteOfId: null,
    reason: null,
    previousAttemptId: null,
    rejectionMessage: null,
    creditedCents: 0,
    ageMinutes: null,
    outageFlag: false,
    hasPdf: true,
    createdAt: '2031-05-20T13:00:00.000Z',
    issuedAt: '2031-05-20T13:00:05.000Z',
    lines: [
      {
        id: IDS.invoiceLine,
        chargeLineId: IDS.chargeLine,
        chargeId: IDS.charge,
        description: 'Consulta profesional',
        amountCents: 2_000_000,
      },
    ],
    ...overrides,
  };
}

/** A pending invoice that has waited `ageMinutes`; past 24 hours it is flagged. */
export function pending(ageMinutes: number, overrides: Partial<InvoiceDto> = {}): InvoiceDto {
  return invoice({
    status: 'pending',
    number: null,
    cae: null,
    caeExpiresOn: null,
    issuedAt: null,
    hasPdf: false,
    ageMinutes,
    outageFlag: ageMinutes >= 24 * 60,
    ...overrides,
  });
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
        id: IDS.chargeLine,
        position: 1,
        kind: 'service',
        portion: 'patient',
        description: 'Consulta',
        amountCents: money(2_000_000),
        invoicedCents: money(0),
      },
    ],
    payments: [],
    totalCents: money(2_000_000),
    patientCents: money(2_000_000),
    payerCents: money(0),
    paidCents: money(0),
    outstandingCents: money(2_000_000),
    creditCents: money(0),
    invoicedCents: money(0),
    invoicing: 'not_invoiced',
    snapshot: {
      quote: null,
      explicitAmountCents: null,
      appointmentTypeName: 'Consulta',
      serviceDate: '2031-05-12',
    },
    capturedBy: '0190a000-0000-7000-8000-000000000001',
    capturedAt: '2031-05-12T12:55:00.000Z',
    ...overrides,
  };
}

/** A charge made for a payer: the payer line (1.500) and the copago of the patient (300). */
export function coveredCharge(): ChargeDto {
  return charge({
    tenantPayerId: IDS.payer,
    payerName: 'OSDE',
    lines: [
      {
        id: IDS.payerLine,
        position: 1,
        kind: 'payer_coverage',
        portion: 'payer',
        description: 'Consulta',
        amountCents: money(1_500_000),
        invoicedCents: money(0),
      },
      {
        id: IDS.chargeLine,
        position: 2,
        kind: 'copago',
        portion: 'patient',
        description: 'Copago',
        amountCents: money(300_000),
        invoicedCents: money(0),
      },
    ],
    totalCents: money(1_800_000),
    patientCents: money(300_000),
    payerCents: money(1_500_000),
  });
}

/** A charge whose only line is invoiced in full: nothing is left to invoice. */
export function fullyInvoiced(): ChargeDto {
  return charge({
    lines: [
      {
        id: IDS.chargeLine,
        position: 1,
        kind: 'service',
        portion: 'patient',
        description: 'Consulta',
        amountCents: money(2_000_000),
        invoicedCents: money(2_000_000),
      },
    ],
    invoicedCents: money(2_000_000),
    invoicing: 'invoiced',
  });
}

export const monotributoOptions: InvoicingOptionsDto = {
  taxCondition: 'monotributo',
  types: [
    { recipient: 'consumidor_final', type: 'FC' },
    { recipient: 'responsable_inscripto', type: 'FC' },
    { recipient: 'monotributo', type: 'FC' },
    { recipient: 'exento', type: 'FC' },
  ],
  pointsOfSale: [{ number: 1, environment: 'homologation' }],
};

export const inscriptoOptions: InvoicingOptionsDto = {
  taxCondition: 'responsable_inscripto',
  types: [
    { recipient: 'consumidor_final', type: 'FB' },
    { recipient: 'responsable_inscripto', type: 'FA' },
    { recipient: 'monotributo', type: 'FB' },
    { recipient: 'exento', type: 'FB' },
  ],
  pointsOfSale: [{ number: 1, environment: 'homologation' }],
};

export const readyToIssue = { available: true, reasons: [], simulated: true } as const;
