import type { BadgeTone } from '../badge.js';

/**
 * Surface and text of an event for each tone. Every pair is a `*-soft` background with its own
 * foreground, so contrast comes from the tokens (checked in `tokens.test.ts`), and a status is
 * always also an icon and a word.
 */
export const TONE_SURFACE: Record<BadgeTone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  success: 'bg-success-soft text-success-soft-foreground',
  warning: 'bg-warning-soft text-warning-soft-foreground',
  danger: 'bg-danger-soft text-danger-soft-foreground',
  info: 'bg-info-soft text-info-soft-foreground',
  brand: 'bg-accent text-accent-foreground',
};
