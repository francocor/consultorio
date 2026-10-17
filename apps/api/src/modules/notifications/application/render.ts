import type { AppointmentMessageKind, MessageChannel } from '@consultorio/contracts';

import {
  FALLBACK_LINK_NOTE,
  OPT_OUT_LABEL,
  OPT_OUT_SENTENCE,
  emailParts,
  type EmailLinks,
} from '../assets/es-AR/email.js';
import type { WhatsAppTemplateKey } from '../assets/es-AR/whatsapp.js';
import {
  describeAppointment,
  type AppointmentFacts,
  type MessageVars,
  type VideoNote,
  type Wording,
} from '../domain/content.js';

/**
 * Writes a message in es-AR from administrative facts only (spec "Message content and privacy").
 * The input is a closed type: a diagnosis, a note or any clinical field is a compile-time error,
 * and the vars are copied one by one, so nothing outside the list is ever printed.
 */

export interface RenderInput {
  kind: AppointmentMessageKind;
  channel: MessageChannel;
  facts: AppointmentFacts;
  wording: Wording;
  /** Email only. WhatsApp replies with fixed options instead of links. */
  links?: EmailLinks;
  /** The video call of a virtual appointment: its join address, or that the link follows. */
  video?: VideoNote;
}

export interface RenderedEmail {
  channel: 'email';
  subject: string;
  text: string;
  html: string;
}

export interface RenderedWhatsApp {
  channel: 'whatsapp';
  templateKey: WhatsAppTemplateKey;
  vars: Record<string, string>;
}

export type RenderedMessage = RenderedEmail | RenderedWhatsApp;

const TEMPLATE_OF_KIND: Record<AppointmentMessageKind, WhatsAppTemplateKey> = {
  reminder: 'appointment_reminder',
  confirmation: 'appointment_confirmation',
  waitlist_offer: 'waitlist_offer',
};

/** The word for the mode of a video consultation, in the details of every message. */
const VIDEO_MODE = 'Videollamada';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** Only web links go into an email: anything else could run script or open an app. */
function assertWebLink(link: string): void {
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(link)) throw new Error('The email link must be http(s)');
}

function detailRows(vars: MessageVars, video: VideoNote | undefined): [string, string][] {
  const rows: [string, string][] = [
    ['Fecha', vars.date],
    ['Hora', vars.time],
    ['Lugar', vars.place],
  ];
  if (video !== undefined) rows.push(['Modalidad', VIDEO_MODE]);
  if (vars.professional !== undefined) rows.push(['Profesional', vars.professional]);
  if (vars.type !== undefined) rows.push(['Tipo de turno', vars.type]);
  return rows;
}

function renderEmail(input: RenderInput, vars: MessageVars): RenderedEmail {
  const links = input.links ?? {};
  const joinUrl = input.video?.kind === 'link' ? input.video.url : undefined;
  for (const link of [
    links.confirmUrl,
    links.cancelUrl,
    links.offerUrl,
    links.optOutUrl,
    joinUrl,
  ]) {
    if (link !== undefined) assertWebLink(link);
  }
  const parts = emailParts(input.kind, vars, links, input.video);
  const rows = detailRows(vars, input.video);
  const optOut =
    links.optOutUrl === undefined
      ? undefined
      : { sentence: OPT_OUT_SENTENCE, label: OPT_OUT_LABEL, url: links.optOutUrl };
  const actions = optOut ? [...parts.actions, optOut] : parts.actions;

  const text = [
    `Hola ${vars.name}:`,
    '',
    parts.intro,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...actions.flatMap((action) => ['', action.sentence, action.url]),
  ].join('\n');

  const detailHtml = rows
    .map(([label, value]) => `<li><strong>${label}:</strong> ${escapeHtml(value)}</li>`)
    .join('\n');
  const actionHtml = actions
    .map(
      (action) =>
        `<p>${escapeHtml(action.sentence)}<br><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p>`,
    )
    .join('\n');
  const html = `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<p>Hola ${escapeHtml(vars.name)}:</p>
<p>${escapeHtml(parts.intro)}</p>
<ul>
${detailHtml}
</ul>
${actionHtml}
<p style="font-size: 13px; color: #6b7280;">${FALLBACK_LINK_NOTE}</p>
</body>
</html>`;

  return { channel: 'email', subject: parts.subject, text, html };
}

function renderWhatsApp(input: RenderInput, vars: MessageVars): RenderedWhatsApp {
  // Copied key by key (not spread) so the variables are exactly the ones a template declares.
  const out: Record<string, string> = {
    name: vars.name,
    organization: vars.organization,
    date: vars.date,
    time: vars.time,
    place: vars.place,
  };
  if (vars.professional !== undefined) out['professional'] = vars.professional;
  if (vars.type !== undefined) out['type'] = vars.type;
  if (input.kind === 'waitlist_offer') {
    const offerUrl = input.links?.offerUrl;
    if (offerUrl !== undefined) {
      assertWebLink(offerUrl);
      out['offerUrl'] = offerUrl;
    }
    if (vars.offerExpires !== undefined) out['offerExpires'] = vars.offerExpires;
  }
  if (input.video !== undefined) out['mode'] = VIDEO_MODE;
  if (input.video?.kind === 'link') {
    assertWebLink(input.video.url);
    out['joinUrl'] = input.video.url;
  }
  return { channel: 'whatsapp', templateKey: TEMPLATE_OF_KIND[input.kind], vars: out };
}

export function renderMessage(input: RenderInput): RenderedMessage {
  const vars = describeAppointment(input.facts, input.wording);
  return input.channel === 'email' ? renderEmail(input, vars) : renderWhatsApp(input, vars);
}
