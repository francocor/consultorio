import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../shared/test/a11y.js';
import { bootFor, meFor } from '../shared/test/fixtures.js';
import { renderApp, renderInRouter } from '../shared/test/render-app.js';

import { BottomNav } from './BottomNav.js';
import { NAV_ITEMS } from './nav/nav-config.js';
import { StatusBanners } from './StatusBanners.js';

const sidebar = () => screen.getByRole('navigation', { name: 'Navegación principal' });
const bottom = () => screen.getByRole('navigation', { name: 'Navegación inferior' });

describe('AppShell: navigation driven by the role', () => {
  it('reception sees the patient areas and no clinical entry point', async () => {
    const app = renderApp({ me: meFor(['reception']) });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bienvenido a Clínica Norte' }),
    ).toBeInTheDocument();
    for (const nav of [sidebar(), bottom()]) {
      expect(within(nav).getByRole('link', { name: 'Inicio' })).toBeInTheDocument();
      expect(within(nav).getByRole('link', { name: 'Pacientes' })).toBeInTheDocument();
      for (const hidden of ['Equipo', 'Auditoría', 'Configuración', 'Recetas', 'Borradores']) {
        expect(within(nav).queryByRole('link', { name: hidden })).not.toBeInTheDocument();
      }
    }
    expect(app.missingKeys).toEqual([]);
  });

  it('owner and admin get settings, staff and audit', async () => {
    renderApp({ me: meFor(['owner']) });

    await screen.findByRole('heading', { level: 1 });
    for (const label of ['Pacientes', 'Equipo', 'Auditoría', 'Configuración']) {
      expect(within(sidebar()).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(within(sidebar()).queryByRole('link', { name: 'Recetas' })).not.toBeInTheDocument();
  });

  it('marks the current page for assistive technology', async () => {
    renderApp({ me: meFor(['owner']) });

    await screen.findByRole('heading', { level: 1 });

    expect(within(sidebar()).getByRole('link', { name: 'Inicio' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(sidebar()).getByRole('link', { name: 'Pacientes' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('has a skip link as the first focusable element and a labelled main region', async () => {
    const user = userEvent.setup();
    renderApp({ me: meFor(['reception']) });
    await screen.findByRole('heading', { level: 1 });

    await user.tab();

    expect(screen.getByRole('link', { name: 'Saltar al contenido principal' })).toHaveFocus();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('shows the organization name, and its logo when it has one', async () => {
    renderApp({
      me: meFor(['reception']),
      boot: bootFor('Centro Médico Aillu', { logoUrl: '/public/branding/logo?v=3' }),
    });

    const logo = await screen.findAllByAltText('Logotipo de Centro Médico Aillu');
    expect(logo[0]).toHaveAttribute('src', '/public/branding/logo?v=3');
    expect(screen.getAllByText('Centro Médico Aillu').length).toBeGreaterThan(0);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderApp({ me: meFor(['owner']) });
    await screen.findByRole('heading', { level: 1 });

    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe('AppShell: guards', () => {
  it('sends a visitor without a session to the sign-in screen, remembering where they were going', async () => {
    const app = renderApp({ me: null, path: '/patients' });

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/login');
    });
    expect(app.router.state.location.search).toMatchObject({ redirect: '/patients' });
  });

  it('shows "no access" for an address the role cannot use, and fetches nothing for it', async () => {
    const app = renderApp({ me: meFor(['reception']), path: '/staff' });

    expect(
      await screen.findByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir al inicio' })).toHaveAttribute('href', '/');
    expect(app.requests.filter((request) => request.includes('/staff'))).toEqual([]);
  });

  it('shows a calm "not found" inside the shell for an unknown address', async () => {
    renderApp({ me: meFor(['reception']), path: '/no-existe' });

    expect(
      await screen.findByRole('heading', { name: 'No encontramos esta página' }),
    ).toBeInTheDocument();
    expect(within(sidebar()).getByRole('link', { name: 'Pacientes' })).toBeInTheDocument();
  });

  it('keeps a session that can only enroll the second factor on the enrollment page', async () => {
    const app = renderApp({
      me: meFor(['professional'], { scope: 'two_factor_enrollment' }),
      path: '/patients',
    });

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/account/security');
    });
  });
});

describe('AppShell: user menu', () => {
  it('shows who is signed in and signs out: the cache is emptied and the user is sent to sign in', async () => {
    const user = userEvent.setup();
    const app = renderApp({ me: meFor(['owner']) });
    await screen.findByRole('heading', { level: 1 });
    app.services.queryClient.setQueryData(['patients', 'list'], [{ id: 'p1' }]);

    await user.click(screen.getByRole('button', { name: 'Menú de la cuenta' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('ana.perez@example.test')).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Cerrar sesión' }));

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/login');
    });
    expect(app.requests).toContain('POST /api/auth/logout');
    expect(app.services.queryClient.getQueryData(['patients', 'list'])).toBeUndefined();
  });

  it('lets the person choose the color scheme', async () => {
    const user = userEvent.setup();
    renderApp({ me: meFor(['owner']) });
    await screen.findByRole('heading', { level: 1 });

    await user.click(screen.getByRole('button', { name: 'Menú de la cuenta' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Oscuro' }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    document.documentElement.classList.remove('dark');
    localStorage.clear();
  });
});

describe('BottomNav', () => {
  const items = [
    NAV_ITEMS.home,
    NAV_ITEMS.patients,
    NAV_ITEMS.staff,
    NAV_ITEMS.audit,
    NAV_ITEMS.settings,
    NAV_ITEMS.reports,
    NAV_ITEMS.billing,
  ];

  it('with more than five entries shows four and a "More" sheet with the rest', async () => {
    const user = userEvent.setup();
    renderInRouter(<BottomNav items={items} />);

    const nav = within(await screen.findByRole('navigation', { name: 'Navegación inferior' }));
    expect(nav.getAllByRole('link')).toHaveLength(4);

    await user.click(nav.getByRole('button', { name: 'Más' }));
    const sheet = await screen.findByRole('dialog', { name: 'Más secciones' });
    expect(within(sheet).getByRole('link', { name: 'Configuración' })).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: 'Informes' })).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: 'Facturación' })).toBeInTheDocument();
  });

  it('with five or fewer entries shows them all and no "More"', async () => {
    renderInRouter(<BottomNav items={items.slice(0, 5)} />);

    const nav = within(await screen.findByRole('navigation', { name: 'Navegación inferior' }));
    expect(nav.getAllByRole('link')).toHaveLength(5);
    expect(nav.queryByRole('button', { name: 'Más' })).not.toBeInTheDocument();
  });
});

describe('banners wired to real signals', () => {
  it('read-only: after a 402 from the API the banner explains the state and the way out', async () => {
    const app = renderApp({ me: meFor(['owner']) });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('Organización en modo de solo lectura')).not.toBeInTheDocument();

    app.services.status.set({ readOnly: true });

    expect(await screen.findByText('Organización en modo de solo lectura')).toBeInTheDocument();
  });

  it('read-only: the banner is there from sign-in when /auth/me says the organization is read only', async () => {
    renderApp({ me: meFor(['owner'], { tenantStatus: 'read_only' }) });

    expect(await screen.findByText('Organización en modo de solo lectura')).toBeInTheDocument();
  });

  it('offline: the banner follows the device connection', async () => {
    const app = renderApp({ me: meFor(['reception']) });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/Sin conexión/)).not.toBeInTheDocument();

    app.services.status.set({ online: false });
    expect(await screen.findByText(/Sin conexión/)).toBeInTheDocument();

    app.services.status.set({ online: true });
    await waitFor(() => {
      expect(screen.queryByText(/Sin conexión/)).not.toBeInTheDocument();
    });
  });

  it('two-factor: inside the grace period a reminder with the date, and a link to enroll', async () => {
    renderApp({
      me: meFor(['professional'], {
        twoFactor: { enrolled: false, required: true, graceEndsAt: '2026-03-12T15:00:00.000Z' },
      }),
    });

    expect(await screen.findByText(/Tiene tiempo hasta el 12\/03\/2026/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Activar ahora' })).toHaveAttribute(
      'href',
      '/account/security',
    );
  });

  it('two-factor: no reminder for someone already enrolled', async () => {
    renderApp({ me: meFor(['professional']) });
    await screen.findByRole('heading', { level: 1 });

    expect(screen.queryByText(/Tiene tiempo hasta/)).not.toBeInTheDocument();
  });

  it('StatusBanners renders nothing when every signal is quiet', () => {
    renderInRouter(<StatusBanners me={meFor(['owner'])} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('FirstRunSlot', () => {
  it('offers nothing to a person who does not run the first run, and asks for nothing', async () => {
    const app = renderApp({ me: meFor(['reception']) });

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
    expect(app.requests.filter((request) => request.includes('/api/onboarding'))).toEqual([]);
  });
});

describe('minimal shells for the portal and public booking', () => {
  it('/portal is a separate, minimal shell with no staff navigation', async () => {
    renderApp({ me: null, path: '/portal' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portal de pacientes' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('/book/{slug} names the organization and shows no staff navigation', async () => {
    renderApp({ me: null, path: '/book/clinica-norte' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Reserva de turnos en línea' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Organización: clinica-norte')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
