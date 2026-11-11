import { createHash } from 'node:crypto';

import { formatArs, money } from '@consultorio/contracts';

/**
 * The hosted page of the local Mercado Pago (`/local-providers/mercadopago/checkout/:id`): where the
 * payer of a preapproval authorizes the monthly charge, or pays a one-off link. Server-rendered es-AR
 * HTML, no script, and it says "simulated" in the heading, in the notice and in the title: nothing
 * here moves money, and a card is never typed on it. The buttons are the choices of a payer:
 * approve, reject, leave it pending, abandon.
 */

export interface CheckoutPageModel {
  kind: 'preapproval' | 'link';
  /** What the payer is asked for, in cents. */
  amountCents: number;
  /** For a link: what it pays. */
  title?: string;
  /** What the buttons do, or why there are none. */
  state: 'open' | 'done' | 'cancelled' | 'expired';
}

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

const STYLE = `
body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937; background: #f9fafb; }
main { max-width: 32rem; margin: 0 auto; padding: 1.5rem 1rem; }
.notice { margin: 0 0 1rem; padding: 0.75rem 1rem; border-radius: 6px; background: #fef3c7; color: #78350f; font-weight: 600; }
h1 { margin: 0 0 1rem; font-size: 1.4rem; }
.amount { margin: 0 0 1rem; font-size: 1.8rem; font-weight: 700; }
form { display: flex; flex-direction: column; gap: 0.75rem; }
button { min-height: 44px; padding: 0.6rem 1.2rem; border: 0; border-radius: 6px; background: #0f766e; color: #ffffff; font: inherit; cursor: pointer; }
button.secondary { background: #ffffff; color: #0f766e; border: 2px solid #0f766e; }
button:focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
`;

/** The policy of this page: nothing loads from anywhere, the one stylesheet is pinned by its hash. */
export const CHECKOUT_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MESSAGES: Record<CheckoutPageModel['state'], string> = {
  open: '',
  done: 'Esta operación ya fue completada. Puede volver a la aplicación.',
  cancelled: 'Esta autorización fue cancelada. Vuelva a la aplicación para empezar de nuevo.',
  expired: 'Este enlace de pago venció. Vuelva a la aplicación para generar otro.',
};

export function renderCheckoutPage(model: CheckoutPageModel): string {
  const heading =
    model.kind === 'preapproval' ? 'Autorizar el pago mensual (simulado)' : 'Pagar (simulado)';
  const amount = escapeHtml(formatArs(money(model.amountCents)));
  const what =
    model.kind === 'preapproval'
      ? 'Autoriza un cobro mensual de hasta este importe. Los resúmenes se informan antes de cada cobro.'
      : (model.title ?? 'Pago único');
  const buttons =
    model.state === 'open'
      ? `<form method="post">
${
  model.kind === 'preapproval'
    ? `<button type="submit" name="choice" value="approve">Aprobar</button>
<button type="submit" name="choice" value="reject" class="secondary">Rechazar</button>
<button type="submit" name="choice" value="pending" class="secondary">Dejar pendiente</button>
<button type="submit" name="choice" value="abandon" class="secondary">Abandonar</button>`
    : `<button type="submit" name="choice" value="approve">Pagar</button>
<button type="submit" name="choice" value="reject" class="secondary">Rechazar el pago</button>
<button type="submit" name="choice" value="abandon" class="secondary">Abandonar</button>`
}
</form>`
      : `<p>${escapeHtml(MESSAGES[model.state])}</p>`;
  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(heading)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="notice">Mercado Pago simulado: esta página no mueve dinero y no pide datos de tarjeta.</p>
<h1>${escapeHtml(heading)}</h1>
<p class="amount">${amount}</p>
<p>${escapeHtml(what)}</p>
${buttons}
</main>
</body>
</html>
`;
}

/**
 * What the payer sees after deciding: a page that takes them back to the application. It is a page and
 * not a redirect of the form on purpose: the policy of the page says `form-action 'self'`, and a browser
 * applies it to the redirect that follows a post, so a redirect to the application (which lives on the
 * address of the organization, not on the one of this page) would be blocked. Following a link or a
 * `refresh` is not a form action.
 */
export function renderReturnPage(backUrl: string): string {
  const address = escapeHtml(backUrl);
  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="0; url=${address}">
<title>Volviendo a la aplicación</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="notice">Mercado Pago simulado: esta página no mueve dinero y no pide datos de tarjeta.</p>
<h1>Listo</h1>
<p>Lo estamos llevando de vuelta a la aplicación.</p>
<p><a href="${address}">Volver a la aplicación</a></p>
</main>
</body>
</html>
`;
}
