import { describe, expect, it } from 'vitest';

import { PAGE_CONTENT_SECURITY_POLICY, renderTokenPage } from './token-page.js';

describe('renderTokenPage', () => {
  const page = {
    organizationName: 'Centro Médico Aillu',
    title: 'Confirme su asistencia',
    details: [
      { label: 'Fecha', value: 'lunes 12 de mayo' },
      { label: 'Hora', value: '10:00' },
    ],
    action: { label: 'Confirmar asistencia' },
  };

  it('is a complete es-AR page with a language, a title, a main region and one heading', () => {
    const html = renderTokenPage(page);

    expect(html).toContain('<html lang="es-AR">');
    expect(html).toContain('<title>Confirme su asistencia · Centro Médico Aillu</title>');
    expect(html).toContain('<main>');
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });

  it('lists the details and offers a single button that posts back to the same address', () => {
    const html = renderTokenPage(page);

    expect(html).toContain('<dt>Fecha</dt>');
    expect(html).toContain('<dd>lunes 12 de mayo</dd>');
    expect(html).toContain('<dd>10:00</dd>');
    expect(html).toContain('<form method="post">');
    expect(html).toContain('>Confirmar asistencia</button>');
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('names the choice of each button when a page has two, so the handler knows which was pressed', () => {
    const html = renderTokenPage({
      ...page,
      action: { label: 'Aceptar el turno', value: 'accept' },
      secondaryAction: { label: 'No me sirve', value: 'decline' },
    });

    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain(
      '<button type="submit" name="choice" value="accept">Aceptar el turno</button>',
    );
    expect(html).toContain(
      '<button type="submit" class="secondary" name="choice" value="decline">No me sirve</button>',
    );
    expect(html.match(/<form/g)).toHaveLength(1);
  });

  it('leaves a single button unnamed, as before', () => {
    const html = renderTokenPage(page);

    expect(html).toContain('<button type="submit">Confirmar asistencia</button>');
    expect(html).not.toContain('name="choice"');
  });

  it('shows no second button without a first one', () => {
    const html = renderTokenPage({
      organizationName: 'Centro Médico Aillu',
      title: 'Solo informa',
      secondaryAction: { label: 'No me sirve', value: 'decline' },
    });

    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
  });

  it('escapes the labels and the values of the buttons', () => {
    const html = renderTokenPage({
      ...page,
      action: { label: '<b>Sí</b>', value: 'a"b' },
    });

    expect(html).not.toContain('<b>Sí');
    expect(html).toContain('value="a&quot;b"');
    expect(html).toContain('&lt;b&gt;Sí&lt;/b&gt;');
  });

  it('has no button and no form when there is nothing to do', () => {
    const html = renderTokenPage({
      organizationName: 'Centro Médico Aillu',
      title: 'Este enlace no es válido',
      message: 'El enlace no existe, venció o ya se usó.',
    });

    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).toContain('<p>El enlace no existe, venció o ya se usó.</p>');
  });

  it('escapes everything that came from a person or from the database', () => {
    const html = renderTokenPage({
      organizationName: '<img src=x onerror=alert(1)>',
      title: 'Hola "mundo"',
      details: [{ label: 'Lugar', value: 'A & B <script>' }],
      message: "it's <b>bold</b>",
    });

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('A &amp; B &lt;script&gt;');
    expect(html).toContain('Hola &quot;mundo&quot;');
    expect(html).toContain('it&#39;s &lt;b&gt;bold&lt;/b&gt;');
  });

  it('runs no script and links nothing: the policy allows only its own style and a form back to itself', () => {
    const html = renderTokenPage(page);

    expect(html).not.toMatch(/<script|<link|<img|<iframe|<a /);
    expect(PAGE_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(PAGE_CONTENT_SECURITY_POLICY).toContain("form-action 'self'");
    expect(PAGE_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(PAGE_CONTENT_SECURITY_POLICY).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(PAGE_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-inline'");
  });

  it('puts exactly the style the policy hashes in the page', async () => {
    const { createHash } = await import('node:crypto');
    const html = renderTokenPage(page);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    const hash = createHash('sha256').update(style).digest('base64');

    expect(PAGE_CONTENT_SECURITY_POLICY).toContain(`'sha256-${hash}'`);
  });
  it('can end with a link to another page of the organization, and only a web link', () => {
    const html = renderTokenPage({
      organizationName: 'Centro Médico Aillu',
      title: 'Su acceso está activo',
      link: { label: 'Ir al portal', href: 'https://aillu.consultorio.test/portal' },
    });

    expect(html).toContain(
      '<a class="button" href="https://aillu.consultorio.test/portal">Ir al portal</a>',
    );
    expect(html).not.toContain('<form');
    expect(() =>
      renderTokenPage({
        organizationName: 'Centro Médico Aillu',
        title: 'x',
        link: { label: 'x', href: 'javascript:alert(1)' },
      }),
    ).toThrow(/http/);
  });

  it('keeps the style under the hash of the policy when the link style is part of it', () => {
    expect(renderTokenPage({ organizationName: 'x', title: 'y' })).toContain('a.button');
    expect(PAGE_CONTENT_SECURITY_POLICY).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
  });
});
