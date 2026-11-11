import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../shared/test/a11y.js';
import { lastRegistration, reloads, resetRegistration } from '../shared/test/pwa-register-stub.js';
import { renderWithApp } from '../shared/test/render.js';

import { UpdatePrompt } from './UpdatePrompt.js';

beforeEach(resetRegistration);

/** The app registers asynchronously; wait for it, then say a new version is waiting. */
async function announceNewVersion() {
  await waitFor(() => {
    expect(lastRegistration()).toBeDefined();
  });
  act(() => {
    lastRegistration()?.onNeedRefresh?.();
  });
}

describe('UpdatePrompt', () => {
  it('stays hidden until the service worker says a new version is waiting', async () => {
    renderWithApp(<UpdatePrompt enabled />);

    expect(screen.queryByText('Hay una versión nueva')).not.toBeInTheDocument();
    await announceNewVersion();

    expect(await screen.findByText('Hay una versión nueva')).toBeInTheDocument();
  });

  it('asks before updating: "Actualizar" reloads onto the new version', async () => {
    const user = userEvent.setup();
    const { container, missingKeys } = renderWithApp(<UpdatePrompt enabled />);
    await announceNewVersion();

    expect(await a11yViolations(container)).toEqual([]);
    await user.click(await screen.findByRole('button', { name: 'Actualizar' }));

    expect(reloads).toEqual([true]);
    expect(missingKeys).toEqual([]);
  });

  it('"Más tarde" dismisses it without touching the running version', async () => {
    const user = userEvent.setup();
    renderWithApp(<UpdatePrompt enabled />);
    await announceNewVersion();

    await user.click(await screen.findByRole('button', { name: 'Más tarde' }));

    expect(screen.queryByText('Hay una versión nueva')).not.toBeInTheDocument();
    expect(reloads).toEqual([]);
  });

  it('does not register a service worker when disabled (development and tests)', () => {
    renderWithApp(<UpdatePrompt enabled={false} />);

    expect(lastRegistration()).toBeUndefined();
  });
});
