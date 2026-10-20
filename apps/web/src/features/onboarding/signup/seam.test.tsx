import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { defaultRegistry } from '../../../app/registry.js';
import { renderApp } from '../../../shared/test/render-app.js';
import { problemResponse } from '../../../shared/test/render.js';

describe('the signup registrations (a public page of the platform host)', () => {
  it('opens /signup on the platform host with no session and no organization', async () => {
    renderApp({ platform: true, me: null, path: '/signup' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Cree su cuenta' }),
    ).toBeInTheDocument();
  });

  it('does not exist on the host of an organization, which already is one', async () => {
    renderApp({ me: null, path: '/signup' });

    // Without a session an organization's host takes a visitor to the sign-in.
    expect(await screen.findByRole('button', { name: 'Ingresar' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Cree su cuenta' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the operator console where it was: / on the platform host is still the console', async () => {
    renderApp({
      platform: true,
      me: null,
      path: '/',
      routes: { 'GET /api/operator/me': () => problemResponse(401, 'unauthenticated') },
    });

    expect(await screen.findByLabelText('Código de verificación')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Cree su cuenta' }),
    ).not.toBeInTheDocument();
  });

  it('registers the route in the platform mount', () => {
    const registered = defaultRegistry().routes.filter((route) => route.mount === 'platform');

    expect(registered.length).toBeGreaterThanOrEqual(1);
  });
});
