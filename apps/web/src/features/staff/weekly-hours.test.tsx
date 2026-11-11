import type { LocationDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { renderWithApp } from '../../shared/test/render.js';

import { WeeklyHours } from './components/WeeklyHours.js';
import { IDS, LOCATIONS } from './fixtures.js';

const [central, norte] = LOCATIONS;
if (!central || !norte) throw new Error('fixtures');
const PLACES: LocationDto[] = [central, norte];

function view(rows = [] as { locationId: string; weekday: number; start: string; end: string }[]) {
  const onSave = vi.fn();
  const result = renderWithApp(
    <WeeklyHours locations={PLACES} rows={rows} saving={false} onSave={onSave} />,
  );
  return { ...result, onSave };
}

describe('WeeklyHours', () => {
  it('shows each location with its time zone and the days with and without attention', () => {
    view([{ locationId: IDS.central, weekday: 1, start: '09:00', end: '13:00' }]);

    const place = screen.getByRole('group', { name: 'Horarios en Sede Central' });
    expect(
      within(place).getByText('Zona horaria: America/Argentina/Buenos_Aires'),
    ).toBeInTheDocument();
    expect(within(place).getByLabelText('Desde (Lunes)')).toHaveValue('09:00');
    expect(within(place).getByLabelText('Hasta (Lunes)')).toHaveValue('13:00');
    expect(within(place).getAllByText('Sin atención')).toHaveLength(6);
    expect(
      within(screen.getByRole('group', { name: 'Horarios en Consultorios Norte' })).getAllByText(
        'Sin atención',
      ),
    ).toHaveLength(7);
  });

  it('adds an interval to a day and saves the whole week', async () => {
    const user = userEvent.setup();
    const { onSave } = view();
    const place = screen.getByRole('group', { name: 'Horarios en Sede Central' });

    await user.click(
      within(place).getByRole('button', { name: 'Agregar una franja el Miércoles' }),
    );
    const start = within(place).getByLabelText('Desde (Miércoles)');
    const end = within(place).getByLabelText('Hasta (Miércoles)');
    await user.clear(start);
    await user.type(start, '0900');
    await user.clear(end);
    await user.type(end, '1300');
    await user.click(screen.getByRole('button', { name: 'Guardar horarios' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith([
        { locationId: IDS.central, weekday: 3, start: '09:00', end: '13:00' },
      ]);
    });
  });

  it('removes an interval', async () => {
    const user = userEvent.setup();
    const { onSave } = view([
      { locationId: IDS.central, weekday: 2, start: '09:00', end: '12:00' },
      { locationId: IDS.central, weekday: 2, start: '15:00', end: '18:00' },
    ]);

    await user.click(
      screen.getByRole('button', { name: 'Quitar la franja del Martes de 09:00 a 12:00' }),
    );
    await user.click(screen.getByRole('button', { name: 'Guardar horarios' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith([
        { locationId: IDS.central, weekday: 2, start: '15:00', end: '18:00' },
      ]);
    });
  });

  it('explains in Spanish why an interval is not valid and does not save', async () => {
    const user = userEvent.setup();
    const { onSave } = view([
      { locationId: IDS.central, weekday: 1, start: '13:00', end: '09:00' },
      { locationId: IDS.central, weekday: 4, start: '09:00', end: '12:00' },
      { locationId: IDS.central, weekday: 4, start: '11:00', end: '14:00' },
    ]);

    await user.click(screen.getByRole('button', { name: 'Guardar horarios' }));

    expect(
      await screen.findByText('La hora de fin debe ser posterior a la de inicio.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Esta franja se superpone con otra del mismo día.')).toHaveLength(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = view([
      { locationId: IDS.central, weekday: 1, start: '09:00', end: '13:00' },
    ]);

    expect(await a11yViolations(container)).toEqual([]);
  });
});
