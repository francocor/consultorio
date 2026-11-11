import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import {
  fakeFetch,
  jsonResponse,
  problemResponse,
  renderWithApp,
} from '../../shared/test/render.js';

import { PatientPicker } from './components/PatientPicker.js';
import { SUMMARIES } from './fixtures.js';

function mount(
  routes: Parameters<typeof fakeFetch>[0] = {},
  onSelect: (patient: unknown) => void = () => undefined,
) {
  const searched: string[] = [];
  const app = renderWithApp(<PatientPicker onSelect={onSelect} />, {
    fetch: fakeFetch({
      'GET /api/patients': (url) => {
        searched.push(new URL(url, 'http://localhost').searchParams.get('q') ?? '');
        return jsonResponse({ patients: SUMMARIES, nextCursor: null });
      },
      ...routes,
    }),
  });
  return { ...app, searched };
}

describe('PatientPicker', () => {
  it('is a labelled combobox that starts closed', () => {
    mount();

    const input = screen.getByRole('combobox', { name: 'Buscar paciente por DNI o nombre' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('searches by what is typed and lists name, document and age', async () => {
    const user = userEvent.setup();
    const app = mount();

    await user.type(screen.getByRole('combobox'), 'gom');

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent('Gómez, Valentina');
    expect(options[0]).toHaveTextContent('99.000.001');
    expect(options[2]).toHaveTextContent('Sin documento');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
    expect(app.searched.at(-1)).toBe('gom');
    expect(app.missingKeys).toEqual([]);
  });

  it('waits for two characters before asking the server', async () => {
    const user = userEvent.setup();
    const app = mount();

    await user.type(screen.getByRole('combobox'), 'g');
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(app.searched).toEqual([]);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('chooses with the mouse', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    mount({}, onSelect);

    await user.type(screen.getByRole('combobox'), 'gom');
    await user.click(await screen.findByRole('option', { name: /Rodríguez, Santiago/ }));

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ familyName: 'Rodríguez' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('chooses with the keyboard: arrows move, Enter picks, Escape closes', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    mount({}, onSelect);
    const input = screen.getByRole('combobox');

    await user.type(input, 'gom');
    await screen.findAllByRole('option');
    // The first suggestion is already highlighted, so one arrow lands on the second.
    await user.keyboard('{ArrowDown}');
    const active = screen.getAllByRole('option')[1];
    expect(input).toHaveAttribute('aria-activedescendant', active?.id);
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ familyName: 'Rodríguez' }));

    await user.clear(input);
    await user.type(input, 'nav');
    await screen.findAllByRole('option');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('says calmly when nobody matches', async () => {
    const user = userEvent.setup();
    mount({ 'GET /api/patients': () => jsonResponse({ patients: [], nextCursor: null }) });

    await user.type(screen.getByRole('combobox'), 'zzzz');

    expect(await screen.findByText('No hay pacientes con ese dato.')).toBeInTheDocument();
  });

  it('says so when the search fails, without losing what was typed', async () => {
    const user = userEvent.setup();
    mount({ 'GET /api/patients': () => problemResponse(500, 'internal') });

    await user.type(screen.getByRole('combobox'), 'gom');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('gom');
  });

  it('has no accessibility violations with the results open', async () => {
    const user = userEvent.setup();
    const app = mount();
    await user.type(screen.getByRole('combobox'), 'gom');
    await screen.findAllByRole('option');

    await waitFor(async () => {
      expect(await a11yViolations(app.container)).toEqual([]);
    });
  });
});
