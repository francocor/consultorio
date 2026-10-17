/**
 * Tenant tables of messaging that the demo seed does not fill yet. The demo seed of Stage 3
 * (S3.16, track E) seeds them and removes this file.
 */
export const exemptions: Record<string, string> = {
  message: 'Messages are produced by reminders and confirmations; S3.16 seeds a believable log.',
  message_attempt: 'The attempts of a message; seeded together with the messages by S3.16.',
  whatsapp_usage_event:
    'Counts the WhatsApp messages the provider accepted; S3.16 seeds some usage.',
  whatsapp_usage_alert: 'Written when a quota threshold is crossed; the demo stays below.',
  message_event: 'Status events of the WhatsApp provider; they follow the messages S3.16 seeds.',
  inbound_message: 'Replies of patients arrive by webhook; S3.16 seeds a couple.',
  channel_preference:
    'Opt-ins and opt-outs are recorded by patients and reception; S3.16 seeds a few.',
};
