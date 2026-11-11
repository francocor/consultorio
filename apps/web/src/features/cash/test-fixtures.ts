import { money, type CashSessionDto } from '@consultorio/contracts';

/** Builders of the objects the cash screen reads, for its tests. Whole cents everywhere. */

export const IDS = {
  location: '0190a000-0000-7000-8000-0000000000e1',
  session: '0190a000-0000-7000-8000-0000000000e9',
  payment: '0190a000-0000-7000-8000-0000000000f1',
  charge: '0190a000-0000-7000-8000-0000000000c1',
  user: '0190a000-0000-7000-8000-000000000001',
};

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
        paymentsCents: money(123_450),
        refundsCents: money(0),
        netCents: money(123_450),
      },
    ],
    ...overrides,
  };
}
