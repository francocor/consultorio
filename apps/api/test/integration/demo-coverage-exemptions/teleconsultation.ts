/**
 * Tenant tables of the teleconsultation module that the demo seed leaves empty until the Stage 3
 * seed slice (S3.16, track E) adds a virtual appointment. That slice removes this file.
 */
export const exemptions: Record<string, string> = {
  video_session:
    'S3.16 seeds a virtual appointment with its video session; until then the demo has none.',
};
