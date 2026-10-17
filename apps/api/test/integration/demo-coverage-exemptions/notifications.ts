/**
 * Tenant tables of messaging that the demo seed leaves empty on purpose. The message log, the
 * choices of the patients, the provider events, the replies, the offers and the usage are seeded
 * (Stage 3 demo seed).
 */
export const exemptions: Record<string, string> = {
  whatsapp_usage_alert: 'Written when a quota threshold is crossed; the demo stays below.',
};
