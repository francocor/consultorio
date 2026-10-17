/**
 * Tenant tables of messaging that the demo seed does not fill yet. The demo seed of Stage 3
 * (S3.16, track E) seeds them and removes this file.
 */
export const exemptions: Record<string, string> = {
  message: 'Messages are produced by reminders and confirmations; S3.16 seeds a believable log.',
  message_attempt: 'The attempts of a message; seeded together with the messages by S3.16.',
  channel_preference:
    'Opt-ins and opt-outs are recorded by patients and reception; S3.16 seeds a few.',
};
