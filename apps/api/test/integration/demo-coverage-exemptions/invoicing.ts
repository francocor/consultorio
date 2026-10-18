/**
 * Tables of invoicing that the demo organization leaves empty until the Stage 4 demo seed (S4.16)
 * fills them. The seed slice deletes this file as it adds the data.
 */
export const exemptions: Record<string, string> = {
  fiscal_profile:
    'Seeded by the Stage 4 demo seed (S4.16); the demo organization has no fiscal identity yet.',
  point_of_sale: 'Seeded by the Stage 4 demo seed (S4.16), together with the fiscal profile.',
  fiscal_credential:
    'A certificate is never part of a demo: the demo organization issues through the in-memory fake and holds no credential.',
};
