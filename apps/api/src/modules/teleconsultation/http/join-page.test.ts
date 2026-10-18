import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { renderJoinPage, type JoinPageModel } from './join-page.js';

const base: JoinPageModel = {
  kind: 'early',
  organization: 'Centro Médico Aillu',
  accent: '#03a550',
  opensAt: { date: '12 de mayo', time: '09:45' },
};

describe('join page', () => {
  it('tells an early patient when the room opens and carries the notice about the video service', () => {
    const { html } = renderJoinPage(base);

    expect(html).toContain('<html lang="es-AR">');
    expect(html).toContain('La sala se habilita el 12 de mayo a las 09:45');
    expect(html).toContain('servicio de videollamada de terceros');
    expect(html).toContain('<h1>Su videoconsulta todavía no comenzó</h1>');
    expect(html).toContain('Centro Médico Aillu');
  });

  it.each([
    ['closed', 'La videoconsulta finalizó'],
    ['pending', 'todavía no está disponible'],
  ] as const)('says what a %s link means and keeps the notice', (kind, text) => {
    const { html } = renderJoinPage({ ...base, kind });

    expect(html).toContain(text);
    expect(html).toContain('no graba ni guarda');
  });

  it('offers the ready patient one button that posts back to the page, with the notice above it', () => {
    const page = renderJoinPage({ ...base, kind: 'ready' });

    expect(page.html).toContain('<h1>Su videoconsulta está lista</h1>');
    expect(page.html).toMatch(
      /<form method="post"><button type="submit">Entrar a la videoconsulta/,
    );
    expect(page.html).not.toMatch(/<form[^>]*action=/);
    expect(page.html).toContain('servicio de videollamada de terceros');
    expect(page.hasForm).toBe(true);
    // `form-action 'self'` would stop the browser at the redirect to the call (JD-S3 R2-C3).
    expect(page.contentSecurityPolicy).not.toContain('form-action');
    expect(page.contentSecurityPolicy).toContain("default-src 'none'");
    expect(page.contentSecurityPolicy).not.toMatch(/https?:/);
    expect(renderJoinPage(base).hasForm).toBe(false);
  });

  it('keeps the generic page free of the notice and of anything about the appointment', () => {
    const { html } = renderJoinPage({ ...base, kind: 'unavailable' });

    expect(html).toContain('Este enlace no está disponible');
    expect(html).not.toContain('videollamada de terceros');
    expect(html).not.toContain('09:45');
  });

  it('escapes the organization name, so a name cannot add markup', () => {
    const { html } = renderJoinPage({ ...base, organization: '<img src=x onerror=alert(1)>' });

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('uses the accent color of the organization, and a neutral one when it is not a color', () => {
    expect(renderJoinPage(base).html).toContain('border-top:6px solid #03a550');
    const neutral = renderJoinPage({ ...base, accent: 'red; } body { display:none' }).html;
    expect(neutral).toContain('border-top:6px solid #334155');
    expect(neutral).not.toContain('display:none');
  });

  it('allows exactly its one style block by hash, and nothing else, and is the same every time', () => {
    const first = renderJoinPage(base);
    const style = /<style>([\s\S]*?)<\/style>/.exec(first.html)?.[1] ?? '';
    const hash = createHash('sha256').update(style).digest('base64');

    expect(first.contentSecurityPolicy).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(renderJoinPage(base)).toEqual(first);
  });
});
