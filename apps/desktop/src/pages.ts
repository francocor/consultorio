import { DEFAULT_TIME_ZONE, TIME_ZONES } from './setup-validation.js';

/**
 * The few pages the shell serves itself (`/__setup`, `/__reset`, `/__key`): plain HTML, one stylesheet and
 * one script, served from the same origin so a strict Content Security Policy needs no exceptions. The
 * words are neutral Spanish, in the "usted" form the product uses.
 */

export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<link rel="stylesheet" href="/__assets/page.css">
</head>
<body>
<main class="card">
${body}
</main>
<script src="/__assets/page.js" defer></script>
</body>
</html>
`;
}

function field(options: {
  name: string;
  label: string;
  type?: string;
  autocomplete?: string;
  hint?: string;
  maxlength?: number;
  required?: boolean;
}): string {
  const hint =
    options.hint === undefined
      ? ''
      : `<p class="hint" id="hint-${options.name}">${options.hint}</p>`;
  const describedBy = [
    options.hint === undefined ? '' : `hint-${options.name}`,
    `err-${options.name}`,
  ]
    .filter((id) => id !== '')
    .join(' ');
  return `<div class="field">
<label for="${options.name}">${options.label}</label>
<input id="${options.name}" name="${options.name}" type="${options.type ?? 'text'}" autocomplete="${options.autocomplete ?? 'off'}"${
    options.maxlength === undefined ? '' : ` maxlength="${String(options.maxlength)}"`
  }${options.required === false ? '' : ' required'} aria-describedby="${describedBy}" spellcheck="false">
${hint}<p class="error" id="err-${options.name}" role="alert"></p>
</div>`;
}

const FORM_ERROR = '<p class="error form-error" id="form-error" role="alert"></p>';

export function renderSetupPage(): string {
  const zones = TIME_ZONES.map(
    (zone) =>
      `<option value="${zone.id}"${zone.id === DEFAULT_TIME_ZONE ? ' selected' : ''}>${zone.label}</option>`,
  ).join('\n');
  return layout(
    'Consulvia: configuración inicial',
    `<div id="step-form">
<h1>Bienvenido a Consulvia</h1>
<p class="lead">Complete estos datos para preparar su consultorio. Se piden una sola vez y quedan guardados en esta computadora.</p>
<form id="form" data-endpoint="/__setup" novalidate>
${field({ name: 'organizationName', label: 'Nombre del consultorio', autocomplete: 'organization', maxlength: 80 })}
${field({ name: 'ownerName', label: 'Su nombre y apellido', autocomplete: 'name', maxlength: 100 })}
${field({ name: 'ownerEmail', label: 'Su correo electrónico', type: 'email', autocomplete: 'email', hint: 'Con este correo va a ingresar a Consulvia.', maxlength: 254 })}
<div class="field">
<label for="timeZone">Zona horaria</label>
<select id="timeZone" name="timeZone" aria-describedby="err-timeZone">
${zones}
</select>
<p class="error" id="err-timeZone" role="alert"></p>
</div>
${field({ name: 'password', label: 'Contraseña', type: 'password', autocomplete: 'new-password', hint: 'Al menos 12 caracteres. Una frase larga es una buena opción.', maxlength: 256 })}
${field({ name: 'passwordConfirmation', label: 'Repita la contraseña', type: 'password', autocomplete: 'new-password', maxlength: 256 })}
${FORM_ERROR}
<button type="submit" id="submit">Crear mi consultorio</button>
<p class="busy" id="busy" hidden>Preparando su consultorio. Esto puede demorar unos segundos, no cierre esta ventana.</p>
</form>
</div>
<div id="done" hidden>
<h1>Su consultorio está listo</h1>
<p class="lead">Guarde esta clave de recuperación en un lugar seguro, por ejemplo impresa. Sirve para abrir una copia de seguridad en otra computadora; sin ella, las copias solo se pueden restaurar en esta.</p>
<p class="key" id="recovery-key" data-fill="recoveryKey" aria-label="Clave de recuperación"></p>
<p class="hint">Si la pierde, puede volver a verla desde el icono de Consulvia, junto al reloj de Windows.</p>
<div class="actions">
<button type="button" class="secondary" data-action="print">Imprimir</button>
<button type="button" class="secondary" data-action="copy" data-copy="recovery-key">Copiar</button>
<button type="button" data-action="go-home">Abrir Consulvia</button>
</div>
</div>`,
  );
}

export function renderResetPage(): string {
  return layout(
    'Consulvia: restablecer contraseña',
    `<div id="step-form">
<h1>Restablecer la contraseña de la propietaria</h1>
<p class="lead">Elija una contraseña nueva para la cuenta de la propietaria del consultorio. Se cierran las sesiones abiertas de esa cuenta y se le avisa por correo.</p>
<form id="form" data-endpoint="/__reset" novalidate>
${field({ name: 'recoveryKey', label: 'Clave de recuperación', autocomplete: 'off', hint: 'Es la clave de 30 letras y números que se mostró al configurar Consulvia. Sin ella no se puede restablecer la contraseña.', maxlength: 64 })}
${field({ name: 'password', label: 'Contraseña nueva', type: 'password', autocomplete: 'new-password', hint: 'Al menos 12 caracteres. Una frase larga es una buena opción.', maxlength: 256 })}
${field({ name: 'passwordConfirmation', label: 'Repita la contraseña nueva', type: 'password', autocomplete: 'new-password', maxlength: 256 })}
<div class="field check">
<input id="clearSecondFactor" name="clearSecondFactor" type="checkbox" aria-describedby="hint-clearSecondFactor">
<label for="clearSecondFactor">Quitar también la verificación en dos pasos</label>
<p class="hint" id="hint-clearSecondFactor">Marque esta opción si perdió el teléfono con el que la configuró. La propietaria podrá volver a activarla desde su cuenta.</p>
</div>
${FORM_ERROR}
<button type="submit" id="submit">Restablecer contraseña</button>
<p class="busy" id="busy" hidden>Actualizando la contraseña…</p>
</form>
</div>
<div id="done" hidden>
<h1>La contraseña se actualizó</h1>
<p class="lead">La cuenta <strong data-fill="email"></strong> ya puede ingresar con la contraseña nueva.</p>
<p class="hint" id="second-factor-note" data-fill="secondFactorNote"></p>
<div class="actions"><button type="button" data-action="close">Cerrar</button></div>
</div>`,
  );
}

export function renderKeyPage(): string {
  return layout(
    'Consulvia: clave de recuperación',
    `<div id="step-form">
<h1>Clave de recuperación</h1>
<p class="lead">Esta copia de seguridad se hizo en otra instalación de Consulvia. Para abrirla, ingrese la clave de recuperación que se mostró al configurar aquella instalación.</p>
<form id="form" data-endpoint="/__key" novalidate>
${field({ name: 'recoveryKey', label: 'Clave de recuperación', autocomplete: 'off', hint: 'Son 30 letras y números, en grupos de cinco.', maxlength: 64 })}
${FORM_ERROR}
<button type="submit" id="submit">Continuar con la restauración</button>
<p class="busy" id="busy" hidden>Comprobando la clave…</p>
</form>
</div>
<div id="done" hidden>
<h1>Clave correcta</h1>
<p class="lead">Consulvia está restaurando la copia. Puede cerrar esta ventana.</p>
<div class="actions"><button type="button" data-action="close">Cerrar</button></div>
</div>`,
  );
}

export const PAGE_CSS = `
:root { color-scheme: light dark; --accent: #0f766e; --accent-text: #ffffff; --bg: #f3f6f6; --card: #ffffff; --text: #17262b; --muted: #50646a; --line: #c5d2d4; --danger: #b42318; }
@media (prefers-color-scheme: dark) { :root { --accent: #2dd4bf; --accent-text: #052e2b; --bg: #0f1a1c; --card: #172427; --text: #e6f0f1; --muted: #9db3b7; --line: #31464a; --danger: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--text); font: 16px/1.5 "Segoe UI", system-ui, sans-serif; }
.card { width: 100%; max-width: 520px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
h1 { margin: 0 0 8px; font-size: 1.5rem; line-height: 1.25; }
.lead { margin: 0 0 20px; color: var(--muted); }
.field { margin: 0 0 16px; }
label { display: block; margin: 0 0 4px; font-weight: 600; }
input[type=text], input[type=email], input[type=password], select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
input:focus-visible, select:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
input[aria-invalid=true] { border-color: var(--danger); }
.hint { margin: 4px 0 0; font-size: 0.875rem; color: var(--muted); }
.error { margin: 4px 0 0; min-height: 0; font-size: 0.875rem; color: var(--danger); }
.error:empty { display: none; }
.field.check { display: grid; grid-template-columns: auto 1fr; gap: 0 10px; align-items: start; }
.field.check label { margin: 0; font-weight: 600; }
.field.check .hint { grid-column: 2; }
.field.check input { margin-top: 5px; width: 18px; height: 18px; }
button { padding: 10px 18px; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer; }
button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
button:disabled { opacity: 0.6; cursor: progress; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
.busy { margin: 12px 0 0; color: var(--muted); }
.key { margin: 12px 0; padding: 14px; border: 1px dashed var(--line); border-radius: 8px; font: 600 1.25rem/1.4 Consolas, "Courier New", monospace; letter-spacing: 0.05em; text-align: center; word-break: break-all; user-select: all; }
@media print { body { background: #fff; color: #000; } .actions, .busy { display: none; } .card { border: 0; } }
`;

/**
 * One script for the three pages. A form with `data-endpoint` is sent as JSON with the one-time token of
 * the address (`?t=`) in a header that another page cannot add without the browser asking first. The
 * answer is `{ ok, errors, message, ...values }`; the values fill the elements marked `data-fill`.
 */
export const PAGE_JS = `(function () {
  'use strict';
  var token = new URLSearchParams(window.location.search).get('t') || '';
  var form = document.getElementById('form');

  function byId(id) { return document.getElementById(id); }
  function setText(id, text) { var el = byId(id); if (el) { el.textContent = text || ''; } }

  function clearErrors() {
    var errors = document.querySelectorAll('.error');
    for (var i = 0; i < errors.length; i += 1) { errors[i].textContent = ''; }
    var inputs = document.querySelectorAll('[aria-invalid]');
    for (var j = 0; j < inputs.length; j += 1) { inputs[j].removeAttribute('aria-invalid'); }
  }

  function showErrors(errors, message) {
    var first = null;
    Object.keys(errors || {}).forEach(function (name) {
      setText('err-' + name, errors[name]);
      var input = byId(name);
      if (input) { input.setAttribute('aria-invalid', 'true'); if (!first) { first = input; } }
    });
    setText('form-error', message || '');
    if (first) { first.focus(); }
  }

  function collect() {
    var data = {};
    var controls = form.elements;
    for (var i = 0; i < controls.length; i += 1) {
      var control = controls[i];
      if (!control.name) { continue; }
      data[control.name] = control.type === 'checkbox' ? control.checked : control.value;
    }
    return data;
  }

  function finish(body) {
    var fills = document.querySelectorAll('[data-fill]');
    for (var i = 0; i < fills.length; i += 1) {
      var value = body[fills[i].getAttribute('data-fill')];
      if (typeof value === 'string') { fills[i].textContent = value; }
    }
    byId('step-form').hidden = true;
    byId('done').hidden = false;
    var heading = document.querySelector('#done h1');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
  }

  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      clearErrors();
      var submit = byId('submit');
      submit.disabled = true;
      byId('busy').hidden = false;
      fetch(form.getAttribute('data-endpoint'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-consulvia-token': token },
        body: JSON.stringify(collect())
      }).then(function (response) {
        return response.json().catch(function () { return {}; });
      }).then(function (body) {
        if (body && body.ok) { finish(body); return; }
        submit.disabled = false;
        byId('busy').hidden = true;
        showErrors(body && body.errors, (body && body.message) || 'No se pudo completar la operación. Intente de nuevo.');
      }).catch(function () {
        submit.disabled = false;
        byId('busy').hidden = true;
        showErrors({}, 'No se pudo comunicar con Consulvia. Intente de nuevo.');
      });
    });
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    var action = target && target.getAttribute && target.getAttribute('data-action');
    if (!action) { return; }
    if (action === 'print') { window.print(); }
    if (action === 'close') { window.close(); }
    if (action === 'go-home') { window.location.assign('/'); }
    if (action === 'copy') {
      var source = byId(target.getAttribute('data-copy'));
      if (source && navigator.clipboard) {
        navigator.clipboard.writeText(source.textContent || '').then(function () { target.textContent = 'Copiada'; });
      }
    }
  });
})();
`;
