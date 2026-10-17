/**
 * What a reply on WhatsApp means (spec "Confirmation by the patient", "Opt-out and consent"). The
 * product understands a handful of fixed replies and nothing else, on purpose: free text is never
 * interpreted, so a patient cannot be signed up, moved or cancelled by a sentence the system
 * guessed at.
 *
 * - `BAJA` or `STOP` opt the patient out of WhatsApp.
 * - `1` confirms the appointment of the reminder; `2` cancels it.
 * - Anything else, including "SI", changes nothing and goes to reception. "SI" never opts in:
 *   a WhatsApp message cannot create an opt-in.
 */

export type ReplyKind = 'opt_out' | 'confirm' | 'cancel' | 'other';

const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set(['BAJA', 'STOP']);

/** The reply without the marks people put around a word: spaces, quotes, ! ? . and the Spanish ¡ ¿. */
function stripped(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/^[\s"'“”‘’¡¿.!?,;:*_-]+|[\s"'“”‘’¡¿.!?,;:*_-]+$/gu, '')
    .toUpperCase();
}

export function classifyReply(text: string): ReplyKind {
  const word = stripped(text);
  if (OPT_OUT_KEYWORDS.has(word)) return 'opt_out';
  if (word === '1') return 'confirm';
  if (word === '2') return 'cancel';
  return 'other';
}
