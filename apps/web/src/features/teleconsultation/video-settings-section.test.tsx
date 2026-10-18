import { DEFAULT_SETTINGS_SECTIONS, type SettingsDto } from '@consultorio/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import {
  fakeFetch,
  jsonBody,
  jsonResponse,
  problemResponse,
  renderWithApp,
  type FetchHandler,
} from '../../shared/test/render.js';

import { VideoSettingsSection } from './components/VideoSettingsSection.js';

const settings = (overrides: Partial<SettingsDto> = {}): SettingsDto => ({
  receptionSeesClinicalMetadata: false,
  clinicalSharing: false,
  sharedTemplates: [],
  require2fa: true,
  quietHours: { start: '21:00', end: '08:00' },
  ...DEFAULT_SETTINGS_SECTIONS,
  ...overrides,
});

function open(routes: Record<string, FetchHandler | Response>) {
  return renderWithApp(<VideoSettingsSection />, {
    fetch: fakeFetch({ 'GET /api/settings': jsonResponse(settings()), ...routes }),
  });
}

describe('the video section of the scheduling settings', () => {
  it('shows whether rooms are created automatically and the two times of the join window', async () => {
    const view = open({});

    expect(await screen.findByRole('heading', { name: 'Videoconsulta' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Crear las salas automáticamente' })).toBeChecked();
    expect(screen.getByText('Salas automáticas activadas')).toBeInTheDocument();
    expect(screen.getByLabelText('La sala se habilita (minutos antes del turno)')).toHaveValue(15);
    expect(
      screen.getByLabelText('Se puede registrar la ausencia (minutos después del inicio)'),
    ).toHaveValue(15);
    expect(screen.getByText(/no graba ni guarda el audio ni el video/)).toBeInTheDocument();
    expect(view.missingKeys).toEqual([]);
  });

  it('says the integration is off, and what that means for the appointments', async () => {
    open({
      'GET /api/settings': jsonResponse(
        settings({ integrations: { whatsapp: true, video: false } }),
      ),
    });

    expect(
      await screen.findByText(
        /Salas automáticas desactivadas: los turnos virtuales esperan un enlace manual/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Crear las salas automáticamente' }),
    ).not.toBeChecked();
  });

  it('switches the integration with one change of its own section, nothing else', async () => {
    const bodies: unknown[] = [];
    open({
      'PATCH /api/settings': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(settings({ integrations: { whatsapp: true, video: false } }));
      },
    });
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('switch', { name: 'Crear las salas automáticamente' }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'Crear las salas automáticamente' }),
      ).not.toBeChecked();
    });
    expect(bodies).toEqual([{ integrations: { video: false } }]);
  });

  it('saves the times of the window, and only after they changed', async () => {
    const bodies: unknown[] = [];
    open({
      'PATCH /api/settings': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(
          settings({ teleconsultation: { joinOpensMinutes: 30, noShowAfterMinutes: 15 } }),
        );
      },
    });
    const user = userEvent.setup();
    const save = await screen.findByRole('button', { name: 'Guardar horarios' });
    expect(save).toBeDisabled();

    const opens = screen.getByLabelText('La sala se habilita (minutos antes del turno)');
    await user.clear(opens);
    await user.type(opens, '30');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => {
      expect(bodies).toEqual([
        { teleconsultation: { joinOpensMinutes: 30, noShowAfterMinutes: 15 } },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Guardar horarios' })).toBeDisabled();
    });
  });

  it.each([
    [
      'La sala se habilita (minutos antes del turno)',
      '121',
      'Ingrese un número de minutos entre 0 y 120.',
    ],
    [
      'La sala se habilita (minutos antes del turno)',
      '',
      'Ingrese un número de minutos entre 0 y 120.',
    ],
    [
      'Se puede registrar la ausencia (minutos después del inicio)',
      '0',
      'Ingrese un número de minutos entre 1 y 120.',
    ],
  ])('refuses %s = "%s" before asking the server', async (label, value, message) => {
    const calls: string[] = [];
    open({
      'PATCH /api/settings': () => {
        calls.push('patch');
        return jsonResponse(settings());
      },
    });
    const user = userEvent.setup();
    const field = await screen.findByLabelText(label);

    await user.clear(field);
    if (value !== '') await user.type(field, value);
    await user.click(screen.getByRole('button', { name: 'Guardar horarios' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('shows the error when the settings cannot be saved', async () => {
    open({ 'PATCH /api/settings': problemResponse(403, 'forbidden') });
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('switch', { name: 'Crear las salas automáticamente' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('No tiene permiso');
  });

  it('has no accessibility violations', async () => {
    const view = open({});
    await screen.findByRole('heading', { name: 'Videoconsulta' });

    expect(await a11yViolations(view.container)).toEqual([]);
  });
});
