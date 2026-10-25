/** The page the window shows while Consulvia starts, and when it has a message instead of the app. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function splashHtml(message: string, busy = true): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Consulvia</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f6f6; color: #17262b; font: 16px/1.5 "Segoe UI", system-ui, sans-serif; }
@media (prefers-color-scheme: dark) { body { background: #0f1a1c; color: #e6f0f1; } }
main { text-align: center; padding: 24px; max-width: 520px; }
h1 { margin: 0 0 12px; font-size: 1.75rem; letter-spacing: 0.02em; }
p { margin: 0; }
.spinner { margin: 24px auto 0; width: 32px; height: 32px; border: 3px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.9s linear infinite; opacity: 0.5; }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<main role="status" aria-live="polite">
<h1>Consulvia</h1>
<p>${escapeHtml(message)}</p>
${busy ? '<div class="spinner" aria-hidden="true"></div>' : ''}
</main>
</body>
</html>
`;
}

export function splashUrl(message: string, busy = true): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(message, busy))}`;
}
