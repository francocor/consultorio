import { createHash } from 'node:crypto';

/**
 * The page a link in an email opens (`/public/t/<token>`): server-rendered es-AR HTML, no script,
 * one optional button that posts back to the same address. It shows an appointment's date, time,
 * place and professional and nothing else: a link is not a login. The same renderer serves the
 * generic "invalid link" page, so every way of failing looks alike.
 */

export interface TokenPageModel {
  organizationName: string;
  title: string;
  /** Label and value rows (date, time, place, professional). */
  details?: readonly { label: string; value: string }[];
  message?: string;
  /**
   * The thing the visitor can do; absent when the page only informs. A page with two choices (an
   * offer to accept or decline) gives each a `value`: the button posts it as `choice`.
   */
  action?: { label: string; value?: string };
  /** A second choice beside the action. Shown only together with an action. */
  secondaryAction?: { label: string; value: string };
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
.organization { margin: 0 0 1rem; font-size: 0.9rem; color: #4b5563; }
h1 { margin: 0 0 1rem; font-size: 1.4rem; }
dl { margin: 0 0 1rem; }
dt { font-weight: 600; }
dd { margin: 0 0 0.5rem; }
button { min-height: 44px; padding: 0.6rem 1.2rem; border: 0; border-radius: 6px; background: #0f766e; color: #ffffff; font: inherit; cursor: pointer; }
button:focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
form { display: flex; flex-wrap: wrap; gap: 0.75rem; }
button.secondary { background: #ffffff; color: #0f766e; border: 2px solid #0f766e; }
`;

/**
 * The policy of these pages: nothing loads from anywhere, the one stylesheet is pinned by its hash
 * (no `unsafe-inline`), the form can only post back to this site, and nothing may frame the page.
 */
export const PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function renderTokenPage(model: TokenPageModel): string {
  const organization = escapeHtml(model.organizationName);
  const title = escapeHtml(model.title);
  const details =
    model.details === undefined || model.details.length === 0
      ? ''
      : `<dl>\n${model.details
          .map((row) => `<dt>${escapeHtml(row.label)}</dt>\n<dd>${escapeHtml(row.value)}</dd>`)
          .join('\n')}\n</dl>`;
  const message = model.message === undefined ? '' : `<p>${escapeHtml(model.message)}</p>`;
  const choice = (value: string | undefined) =>
    value === undefined ? '' : ` name="choice" value="${escapeHtml(value)}"`;
  const buttons =
    model.action === undefined
      ? []
      : [
          `<button type="submit"${choice(model.action.value)}>${escapeHtml(model.action.label)}</button>`,
          ...(model.secondaryAction === undefined
            ? []
            : [
                `<button type="submit" class="secondary"${choice(model.secondaryAction.value)}>${escapeHtml(model.secondaryAction.label)}</button>`,
              ]),
        ];
  const action = buttons.length === 0 ? '' : `<form method="post">\n${buttons.join('\n')}\n</form>`;

  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · ${organization}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="organization">${organization}</p>
<h1>${title}</h1>
${[details, message, action].filter((part) => part !== '').join('\n')}
</main>
</body>
</html>
`;
}
