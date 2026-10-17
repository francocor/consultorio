import { createHash } from 'node:crypto';

/**
 * The page the platform join address shows when it does not forward to the call (teleconsultation,
 * "Link access and validity" and "Privacy and consent"). It is rendered on the server, in es-AR, in
 * the colors of the organization, and it never contains the provider's address or the room.
 *
 * It is a page with no script and no external resource: the only style is one inline block, which
 * the content policy allows by its hash. The page has nothing that varies per visitor, so every
 * answer of one kind is byte for byte the same (an unavailable link teaches nothing).
 */

export type JoinPageKind = 'early' | 'closed' | 'pending' | 'unavailable';

export interface JoinPageModel {
  kind: JoinPageKind;
  organization: string;
  /** A `#rrggbb` color; anything else falls back to a neutral one. */
  accent: string;
  /** For `early`: when the session opens, in the time of the place. */
  opensAt?: { date: string; time: string };
}

const NEUTRAL_ACCENT = '#334155';

const COPY = {
  notice:
    'Esta consulta se realiza mediante un servicio de videollamada de terceros. El centro no graba ni guarda el audio ni el video de la consulta.',
  noticeLabel: 'Aviso sobre la videollamada',
  early: {
    title: 'Su videoconsulta todavía no comenzó',
    body: (when: { date: string; time: string }) =>
      `La sala se habilita el ${when.date} a las ${when.time} (hora del centro). Vuelva a abrir este enlace a partir de ese momento.`,
  },
  closed: {
    title: 'La videoconsulta finalizó',
    body: (organization: string) =>
      `Este enlace ya no permite entrar a la sala. Si necesita atención, comuníquese con ${organization}.`,
  },
  pending: {
    title: 'El enlace de la videoconsulta todavía no está disponible',
    body: (organization: string) =>
      `El centro está preparando la sala. Intente nuevamente en unos minutos o comuníquese con ${organization}.`,
  },
  unavailable: {
    title: 'Este enlace no está disponible',
    body: () =>
      'Puede haber vencido o haber sido reemplazado por uno nuevo. Si tiene un turno, revise el último aviso que recibió o comuníquese con el centro.',
  },
} as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function accentOf(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : NEUTRAL_ACCENT;
}

function contentOf(model: JoinPageModel): { title: string; body: string; withNotice: boolean } {
  switch (model.kind) {
    case 'early':
      return {
        title: COPY.early.title,
        body: COPY.early.body(model.opensAt ?? { date: '', time: '' }),
        withNotice: true,
      };
    case 'closed':
      return {
        title: COPY.closed.title,
        body: COPY.closed.body(model.organization),
        withNotice: true,
      };
    case 'pending':
      return {
        title: COPY.pending.title,
        body: COPY.pending.body(model.organization),
        withNotice: true,
      };
    case 'unavailable':
      return { title: COPY.unavailable.title, body: COPY.unavailable.body(), withNotice: false };
  }
}

export interface RenderedJoinPage {
  html: string;
  /** The content policy that goes with the page: the hash of its one style block, nothing else. */
  contentSecurityPolicy: string;
}

export function renderJoinPage(model: JoinPageModel): RenderedJoinPage {
  const { title, body, withNotice } = contentOf(model);
  const accent = accentOf(model.accent);
  const organization = escapeHtml(model.organization);

  const css = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#0f172a;line-height:1.5}
main{max-width:34rem;margin:0 auto;padding:2rem 1rem 3rem}
.card{background:#ffffff;border:1px solid #cbd5e1;border-top:6px solid ${accent};border-radius:.75rem;padding:1.5rem}
.org{margin:0 0 1rem;font-size:1rem;font-weight:600;color:#1e293b}
h1{margin:0 0 .75rem;font-size:1.5rem;line-height:1.25}
h2{margin:0 0 .25rem;font-size:1rem}
p{margin:0 0 1rem}
.notice{margin-top:1.5rem;padding:1rem;background:#f1f5f9;border-radius:.5rem;color:#1e293b}
.notice p{margin:0;font-size:.9375rem}
`;
  const styleHash = createHash('sha256').update(css).digest('base64');

  const notice = withNotice
    ? `<section class="notice" aria-labelledby="notice-title"><h2 id="notice-title">${escapeHtml(COPY.noticeLabel)}</h2><p>${escapeHtml(COPY.notice)}</p></section>`
    : '';

  const html = `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} - ${organization}</title>
<style>${css}</style>
</head>
<body>
<main>
<div class="card">
<p class="org">${organization}</p>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
${notice}
</div>
</main>
</body>
</html>
`;

  return {
    html,
    contentSecurityPolicy: `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}
