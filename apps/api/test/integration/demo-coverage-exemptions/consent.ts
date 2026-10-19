/**
 * Tables of consent that the demo seed leaves empty until Stage 5 integration (S5.12, Track C),
 * which seeds a template with two versions and signed and revoked consents and removes this file.
 */
export const exemptions: Record<string, string> = {
  consent_template:
    'Seeded by the Stage 5 demo (S5.12, Track C), which builds the templates, their versions and the consents on top of them.',
  consent_template_version:
    'Seeded by the Stage 5 demo (S5.12, Track C): a template with two versions.',
  consent_request:
    'Seeded by the Stage 5 demo (S5.12, Track C): pending, signed, declined and revoked requests.',
  consent_signature:
    'Seeded by the Stage 5 demo (S5.12, Track C): signed consents, written the way the service writes them.',
  consent_revocation: 'Seeded by the Stage 5 demo (S5.12, Track C): a revoked consent.',
};
