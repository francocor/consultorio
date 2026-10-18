/**
 * Tables of billing (Stage 4, track A) that the demo seed does not fill yet. The seed slice (S4.16)
 * writes prices, payers, charges, payments and cash sessions, and deletes this file. Each slice of
 * the track adds the tables its migration creates.
 */
const WAITING = 'Seeded by the Stage 4 demo slice (S4.16).';

export const exemptions: Record<string, string> = {
  tenant_payer: WAITING,
  price: WAITING,
  payer_plan_price: WAITING,
  charge: WAITING,
  charge_line: WAITING,
};
