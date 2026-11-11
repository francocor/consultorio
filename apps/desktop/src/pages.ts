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

/**
 * The box that asks for the last four characters of the recovery key: typing them is the proof that the key
 * was read and not only skipped past. `extra` holds the attributes that tell the script where the form sends
 * its answer and what it shows afterwards.
 */
function confirmKeyForm(
  formId: string,
  extra: string,
  ids: { submit: string; busy: string; error: string },
  words: { button: string; busy: string } = { button: 'La guardé', busy: 'Comprobando…' },
): string {
  return `<form id="${formId}" data-endpoint="/__ack" data-submit="${ids.submit}" data-busy="${ids.busy}" data-error="${ids.error}" ${extra} novalidate>
${field({ name: 'recoveryKeyLast4', label: 'Para confirmar que la guardó, escriba los últimos 4 caracteres de la clave', maxlength: 4 })}
<p class="error form-error" id="${ids.error}" role="alert"></p>
<button type="submit" id="${ids.submit}">${words.button}</button>
<p class="busy" id="${ids.busy}" hidden>${words.busy}</p>
</form>`;
}

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
<p class="hint">¿Ya tiene una copia de seguridad de Consulvia? No complete este formulario: abra el icono de Consulvia junto al reloj de Windows y elija <strong>Restaurar copia…</strong></p>
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
<button type="submit" id="submit">Continuar</button>
<p class="busy" id="busy" hidden>Un momento…</p>
</form>
</div>
<div id="done" hidden>
<h1>Su clave de recuperación</h1>
<p class="lead">Antes de crear su consultorio, guarde esta clave de recuperación en un lugar seguro, por ejemplo impresa. Sirve para abrir una copia de seguridad en otra computadora y para restablecer la contraseña de la propietaria; sin ella no se puede hacer ninguna de las dos cosas.</p>
<p class="hint"><strong>Su consultorio todavía no se creó:</strong> se crea cuando usted confirme, aquí abajo, que guardó la clave. Si cierra esta ventana antes, no queda nada a medias: al abrir Consulvia de nuevo empieza otra vez, con una clave nueva.</p>
<p class="key" id="recovery-key" data-fill="recoveryKey" aria-label="Clave de recuperación"></p>
<p class="hint">Es la única vez que se muestra: Consulvia no la guarda en esta computadora, así que nadie que use la computadora podrá verla después.</p>
<div class="actions">
<button type="button" class="secondary" data-action="print">Imprimir</button>
<button type="button" class="secondary" data-action="copy" data-copy="recovery-key">Copiar</button>
</div>
${confirmKeyForm(
  'ack-box',
  'data-token-from="ackToken" data-hide="ack-box" data-show="ack-done" data-leave="done" data-back="step-form"',
  { submit: 'ack-submit', busy: 'ack-busy', error: 'ack-error' },
  {
    button: 'La guardé: crear mi consultorio',
    busy: 'Creando su consultorio. Esto puede demorar unos segundos, no cierre esta ventana.',
  },
)}
<div id="ack-done" hidden>
<p class="lead"><strong>Listo.</strong> La clave quedó confirmada y su consultorio está creado.</p>
<div class="actions"><button type="button" data-action="go-home">Abrir Consulvia</button></div>
</div>
<p class="hint">Consulvia no vuelve a mostrar esta clave ni la puede recuperar: si cierra esta ventana sin guardarla, tendrá que usar una copia anotada en otro momento.</p>
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

/** Checks a key typed from the paper copy against the install, and shows nothing. */
export function renderCheckPage(): string {
  return layout(
    'Consulvia: comprobar la clave de recuperación',
    `<div id="step-form">
<h1>Comprobar la clave de recuperación</h1>
<p class="lead">Escriba la clave tal como la tiene anotada. Consulvia le dice si es la correcta; no la muestra. Si todavía no había confirmado que la guardó, al escribirla bien queda confirmada.</p>
<form id="form" data-endpoint="/__check" novalidate>
${field({ name: 'recoveryKey', label: 'Clave de recuperación', hint: 'Son 30 letras y números, en grupos de cinco.', maxlength: 64 })}
${FORM_ERROR}
<button type="submit" id="submit">Comprobar</button>
<p class="busy" id="busy" hidden>Comprobando…</p>
</form>
</div>
<div id="done" hidden>
<h1>La clave es correcta</h1>
<p class="lead">Es la clave de recuperación de esta instalación.</p>
<div class="actions"><button type="button" data-action="close">Cerrar</button></div>
</div>`,
  );
}

/**
 * A new recovery key for an install whose key was never confirmed. The old one is lost, so it cannot be what proves
 * who asks: the owner's own password (and second factor) do, and the API checks them.
 */
export function renderRegeneratePage(): string {
  return layout(
    'Consulvia: nueva clave de recuperación',
    `<div id="step-form">
<h1>Generar una nueva clave de recuperación</h1>
<p class="lead">Esta instalación no llegó a confirmar su clave de recuperación. Aquí se genera una nueva; la anterior deja de servir. Para hacerlo Consulvia pide los datos de ingreso de la propietaria, como al entrar al programa.</p>
<form id="form" data-endpoint="/__regen" novalidate>
${field({ name: 'email', label: 'Correo electrónico de la propietaria', type: 'email', autocomplete: 'email', maxlength: 254 })}
${field({ name: 'password', label: 'Contraseña de la propietaria', type: 'password', autocomplete: 'current-password', maxlength: 256 })}
${field({ name: 'code', label: 'Código de la verificación en dos pasos', hint: 'Solo si la cuenta la tiene activada.', autocomplete: 'one-time-code', maxlength: 32, required: false })}
${FORM_ERROR}
<button type="submit" id="submit">Generar una clave nueva</button>
<p class="busy" id="busy" hidden>Comprobando…</p>
</form>
</div>
<div id="done" hidden>
<h1>Su nueva clave de recuperación</h1>
<p class="lead">Guárdela en un lugar seguro, por ejemplo impresa. Sirve para abrir una copia de seguridad en otra computadora y para restablecer la contraseña de la propietaria. Las copias hechas hasta ahora siguen abriéndose en esta computadora; en otra, solo con la clave con la que se hicieron.</p>
<p class="key" id="recovery-key" data-fill="recoveryKey" aria-label="Clave de recuperación"></p>
<p class="hint">Es la única vez que se muestra. La clave anterior sigue vigente hasta que usted confirme esta.</p>
<div class="actions">
<button type="button" class="secondary" data-action="print">Imprimir</button>
<button type="button" class="secondary" data-action="copy" data-copy="recovery-key">Copiar</button>
</div>
${confirmKeyForm('ack-box', 'data-token-from="ackToken" data-hide="ack-box" data-show="ack-done"', { submit: 'ack-submit', busy: 'ack-busy', error: 'ack-error' })}
<div id="ack-done" hidden>
<p class="lead"><strong>Listo.</strong> La clave nueva quedó confirmada.</p>
<div class="actions"><button type="button" data-action="close">Cerrar</button></div>
</div>
</div>`,
  );
}

/** What a restore asks for: the key of THIS install (always, on an install that is in use) and, for a backup of another install, that one's key. */
export interface RestoreKeyNeeds {
  current: boolean;
  backup: boolean;
}

export function renderKeyPage(needs: RestoreKeyNeeds): string {
  const lead = needs.current
    ? needs.backup
      ? 'Esta copia de seguridad se hizo en otra instalación de Consulvia, y restaurarla reemplaza todos los datos de esta. Hacen falta las dos claves de recuperación: la de esta instalación, para confirmar que usted es quien la administra, y la de la instalación de donde viene la copia.'
      : 'Restaurar una copia reemplaza todos los datos de esta instalación. Para confirmar que usted es quien la administra, ingrese la clave de recuperación de esta instalación.'
    : 'Esta copia de seguridad se hizo en otra instalación de Consulvia. Para abrirla, ingrese la clave de recuperación que se mostró al configurar aquella instalación.';
  const current = needs.current
    ? field({
        name: 'currentKey',
        label: 'Clave de recuperación de esta instalación',
        autocomplete: 'off',
        hint: 'Son 30 letras y números, en grupos de cinco.',
        maxlength: 64,
      })
    : '';
  const backup = needs.backup
    ? field({
        name: 'recoveryKey',
        label: needs.current
          ? 'Clave de recuperación de la instalación de donde viene la copia'
          : 'Clave de recuperación',
        autocomplete: 'off',
        hint: 'Son 30 letras y números, en grupos de cinco.',
        maxlength: 64,
      })
    : '';
  return layout(
    'Consulvia: clave de recuperación',
    `<div id="step-form">
<h1>Clave de recuperación</h1>
<p class="lead">${lead}</p>
<form id="form" data-endpoint="/__key" novalidate>
${current}
${backup}
${FORM_ERROR}
<button type="submit" id="submit">Continuar con la restauración</button>
<p class="busy" id="busy" hidden>Comprobando las claves…</p>
</form>
</div>
<div id="done" hidden>
<h1>Claves correctas</h1>
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
 * One script for every page. A form with `data-endpoint` is sent as JSON with the one-time token of the
 * address (`?t=`), or with the token the last answer handed over (`data-token-from`), in a header that
 * another page cannot add without the browser asking first. The answer is `{ ok, errors, message, ...values }`;
 * the values fill the elements marked `data-fill`. On success the form hides `data-hide` and shows
 * `data-show` (by default the form step and the done step of the page).
 */
export const PAGE_JS = `(function () {
  'use strict';
  var token = new URLSearchParams(window.location.search).get('t') || '';
  var answers = {};

  function byId(id) { return document.getElementById(id); }
  function setText(id, text) { var el = byId(id); if (el) { el.textContent = text || ''; } }

  function clearErrors() {
    var errors = document.querySelectorAll('.error');
    for (var i = 0; i < errors.length; i += 1) { errors[i].textContent = ''; }
    var inputs = document.querySelectorAll('[aria-invalid]');
    for (var j = 0; j < inputs.length; j += 1) { inputs[j].removeAttribute('aria-invalid'); }
  }

  function showErrors(errors, message, errorId) {
    var first = null;
    Object.keys(errors || {}).forEach(function (name) {
      setText('err-' + name, errors[name]);
      var input = byId(name);
      if (input) { input.setAttribute('aria-invalid', 'true'); if (!first) { first = input; } }
    });
    setText(errorId, message || '');
    if (first) { first.focus(); }
  }

  function collect(form) {
    var data = {};
    var controls = form.elements;
    for (var i = 0; i < controls.length; i += 1) {
      var control = controls[i];
      if (!control.name) { continue; }
      data[control.name] = control.type === 'checkbox' ? control.checked : control.value;
    }
    return data;
  }

  function finish(form, body) {
    Object.keys(body).forEach(function (name) { answers[name] = body[name]; });
    var fills = document.querySelectorAll('[data-fill]');
    for (var i = 0; i < fills.length; i += 1) {
      var value = body[fills[i].getAttribute('data-fill')];
      if (typeof value === 'string') { fills[i].textContent = value; }
    }
    var hide = byId(form.getAttribute('data-hide') || 'step-form');
    var show = byId(form.getAttribute('data-show') || 'done');
    if (hide) { hide.hidden = true; }
    if (show) {
      show.hidden = false;
      var heading = show.querySelector('h1') || show;
      heading.setAttribute('tabindex', '-1');
      heading.focus();
    }
  }

  function wire(form) {
    var submitId = form.getAttribute('data-submit') || 'submit';
    var busyId = form.getAttribute('data-busy') || 'busy';
    var errorId = form.getAttribute('data-error') || 'form-error';
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      clearErrors();
      var submit = byId(submitId);
      var busy = byId(busyId);
      submit.disabled = true;
      if (busy) { busy.hidden = false; }
      var from = form.getAttribute('data-token-from');
      fetch(form.getAttribute('data-endpoint'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-consulvia-token': from ? (answers[from] || '') : token },
        body: JSON.stringify(collect(form))
      }).then(function (response) {
        return response.json().catch(function () { return {}; });
      }).then(function (body) {
        if (body && body.ok) { finish(form, body); return; }
        submit.disabled = false;
        if (busy) { busy.hidden = true; }
        showErrors(body && body.errors, (body && body.message) || 'No se pudo completar la operación. Intente de nuevo.', errorId);
        if (body && body.back) {
          var leave = byId(form.getAttribute('data-leave'));
          var back = byId(form.getAttribute('data-back'));
          if (leave && back) { leave.hidden = true; back.hidden = false; }
        }
      }).catch(function () {
        submit.disabled = false;
        if (busy) { busy.hidden = true; }
        showErrors({}, 'No se pudo comunicar con Consulvia. Intente de nuevo.', errorId);
      });
    });
  }

  var forms = document.querySelectorAll('form[data-endpoint]');
  for (var f = 0; f < forms.length; f += 1) { wire(forms[f]); }

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
