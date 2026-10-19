/**
 * Tables of the prescriptions module that the demo seed leaves empty until the Stage 5 integration
 * slice (S5.12) seeds them: this file is removed there, with the seed that fills the tables.
 */
export const exemptions: Record<string, string> = {
  prescription:
    'Seeded by the Stage 5 demo (S5.12), through the in-memory fake of the provider; this track only builds the module.',
  erx_connection:
    'The demo organization is switched on by the Stage 5 demo seed (S5.12); until then it holds no connection row.',
};
