import { fireEvent, screen, within } from '@testing-library/react';
import { CircleCheck, Clock, Video } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../test/a11y.js';
import { renderWithApp } from '../../test/render.js';

import { CalendarView } from './CalendarView.js';
import type { CalendarEvent, CalendarViewProps } from './types.js';

const BA = 'America/Argentina/Buenos_Aires';

const RESOURCES = [
  { id: 'ana', label: 'Dra. Ana Pérez', description: 'Cardiología' },
  { id: 'beto', label: 'Dr. Beto Ruiz', description: 'Pediatría' },
];

function event(overrides: Partial<CalendarEvent> & Pick<CalendarEvent, 'id'>): CalendarEvent {
  return {
    resourceId: 'ana',
    start: '2026-10-17T13:00:00.000Z', // 10:00 in Buenos Aires
    end: '2026-10-17T13:30:00.000Z',
    title: 'Gómez, Valentina',
    subtitle: 'Control',
    statusLabel: 'Confirmado',
    statusTone: 'info',
    statusIcon: CircleCheck,
    ...overrides,
  };
}

const EVENTS: CalendarEvent[] = [
  event({ id: 'a1' }),
  event({
    id: 'b1',
    resourceId: 'beto',
    start: '2026-10-17T14:00:00.000Z',
    end: '2026-10-17T14:45:00.000Z',
    title: 'Ríos, Tomás',
    subtitle: 'Primera consulta',
    statusLabel: 'Pendiente de aprobación',
    statusTone: 'warning',
    statusIcon: Clock,
  }),
];

function props(overrides: Partial<CalendarViewProps> = {}): CalendarViewProps {
  return {
    view: 'day',
    date: '2026-10-17',
    timeZone: BA,
    label: 'Agenda del sábado 17 de octubre',
    resources: RESOURCES,
    events: EVENTS,
    onSelectEvent: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the marker of an event', () => {
  const marked = [
    event({ id: 'v1', marker: { icon: Video, label: 'Virtual' } }),
    event({ id: 'p1', resourceId: 'beto', title: 'Ríos, Tomás' }),
  ];

  it('puts the word in the accessible name of the card and an icon on it, in the grid', () => {
    renderWithApp(<CalendarView {...props({ events: marked })} />);

    const virtual = screen.getByRole('button', { name: /Gómez/ });

    expect(virtual).toHaveAccessibleName(/Virtual/);
    expect(within(virtual).getByTestId('event-marker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ríos/ })).not.toHaveAccessibleName(/Virtual/);
    expect(screen.queryAllByTestId('event-marker')).toHaveLength(1);
  });

  it('shows the word as a visible badge in the agenda list', () => {
    renderWithApp(<CalendarView {...props({ events: marked, presentation: 'list' })} />);

    expect(screen.getByText('Virtual')).toBeVisible();
  });

  it('has no accessibility violations with the marker', async () => {
    const { container } = renderWithApp(<CalendarView {...props({ events: marked })} />);

    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe('the day view with a column per professional', () => {
  it('shows each professional as a column heading', () => {
    renderWithApp(<CalendarView {...props()} />);

    expect(screen.getByRole('group', { name: 'Agenda de Dra. Ana Pérez' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Agenda de Dr. Beto Ruiz' })).toBeInTheDocument();
    expect(screen.getByText('Cardiología')).toBeInTheDocument();
  });

  it('puts every appointment in the column of its professional, and in no other', () => {
    renderWithApp(<CalendarView {...props()} />);

    const ana = screen.getByRole('group', { name: 'Agenda de Dra. Ana Pérez' });
    const beto = screen.getByRole('group', { name: 'Agenda de Dr. Beto Ruiz' });

    expect(within(ana).getByRole('button', { name: /Gómez, Valentina/ })).toBeInTheDocument();
    expect(within(ana).queryByRole('button', { name: /Ríos, Tomás/ })).not.toBeInTheDocument();
    expect(within(beto).getByRole('button', { name: /Ríos, Tomás/ })).toBeInTheDocument();
    expect(within(beto).queryByRole('button', { name: /Gómez/ })).not.toBeInTheDocument();
  });

  it('names an appointment with its time, patient, type and status (never color alone)', () => {
    renderWithApp(<CalendarView {...props()} />);

    const button = screen.getByRole('button', { name: /Gómez, Valentina/ });

    expect(button).toHaveAccessibleName(/10:00/);
    expect(button).toHaveAccessibleName(/10:30/);
    expect(button).toHaveAccessibleName(/Control/);
    expect(button).toHaveAccessibleName(/Confirmado/);
    expect(within(button).getByText('Confirmado')).toBeInTheDocument();
  });

  it('shows the time of the location, not the time of the device', () => {
    const { unmount } = renderWithApp(<CalendarView {...props()} />);
    expect(screen.getByRole('button', { name: /Gómez/ })).toHaveAccessibleName(/10:00/);
    unmount();

    renderWithApp(<CalendarView {...props({ timeZone: 'Asia/Tokyo' })} />);
    // The same instant is 22:00 in Tokyo.
    expect(screen.getByRole('button', { name: /Gómez/ })).toHaveAccessibleName(/22:00/);
  });

  it('shows a block as a labelled band in the column of the professional it is for', () => {
    renderWithApp(
      <CalendarView
        {...props({
          backgrounds: [
            {
              id: 'block-1',
              resourceId: 'ana',
              start: '2026-10-17T15:00:00.000Z',
              end: '2026-10-17T16:00:00.000Z',
              label: 'Congreso',
            },
          ],
        })}
      />,
    );

    const ana = screen.getByRole('group', { name: 'Agenda de Dra. Ana Pérez' });
    const beto = screen.getByRole('group', { name: 'Agenda de Dr. Beto Ruiz' });

    expect(within(ana).getByText('Bloqueado: Congreso')).toBeInTheDocument();
    expect(within(beto).queryByText('Bloqueado: Congreso')).not.toBeInTheDocument();
  });

  it('says when the day is a holiday', () => {
    renderWithApp(<CalendarView {...props({ closedDays: { '2026-10-17': 'Día del respeto' } })} />);

    // Each professional's column says it, so a single column read alone is complete.
    expect(screen.getAllByText('Cerrado: Día del respeto')).toHaveLength(2);
  });

  it('widens the hours to show an appointment before the usual opening time', () => {
    renderWithApp(
      <CalendarView
        {...props({
          events: [
            event({
              id: 'early',
              start: '2026-10-17T09:00:00.000Z', // 06:00
              end: '2026-10-17T09:30:00.000Z',
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText('06:00', { selector: '[data-hour-label]' })).toBeInTheDocument();
  });
});

describe('choosing things on the grid', () => {
  it('opens an appointment from the pointer and from the keyboard', () => {
    const onSelectEvent = vi.fn();
    renderWithApp(<CalendarView {...props({ onSelectEvent })} />);

    const button = screen.getByRole('button', { name: /Gómez/ });
    fireEvent.click(button);

    expect(onSelectEvent).toHaveBeenCalledWith('a1');
  });

  it('reports the column and the snapped time of an empty stretch', () => {
    const onSelectSlot = vi.fn();
    renderWithApp(<CalendarView {...props({ onSelectSlot })} />);
    const column = screen.getByRole('group', { name: 'Agenda de Dr. Beto Ruiz' });
    const body = column.querySelector('[data-column-body]');
    expect(body).not.toBeNull();
    // Hours start at 07:00 and an hour is 72 px: 75 px below the top is 08:02, snapped to 08:00.
    vi.spyOn(body as Element, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
      width: 200,
      height: 1000,
      bottom: 1100,
      right: 200,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });

    fireEvent.click(body as Element, { clientY: 175, clientX: 50 });

    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    const slot = onSelectSlot.mock.calls[0]?.[0] as { resourceId: string; start: Date };
    expect(slot.resourceId).toBe('beto');
    expect(slot.start.toISOString()).toBe('2026-10-17T11:00:00.000Z'); // 08:00 in Buenos Aires
  });

  it('does not offer to pick an empty stretch when the grid is read-only', () => {
    renderWithApp(<CalendarView {...props()} />);
    const body = screen
      .getByRole('group', { name: 'Agenda de Dr. Beto Ruiz' })
      .querySelector('[data-column-body]');

    expect(body).not.toHaveAttribute('data-selectable');
  });
});

describe('moving an appointment', () => {
  it('moves it 15 minutes later with Alt and the down arrow', () => {
    const onMoveEvent = vi.fn();
    renderWithApp(
      <CalendarView {...props({ onMoveEvent, events: [event({ id: 'a1', movable: true })] })} />,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: /Gómez/ }), {
      key: 'ArrowDown',
      altKey: true,
    });

    expect(onMoveEvent).toHaveBeenCalledTimes(1);
    const move = onMoveEvent.mock.calls[0]?.[0] as { id: string; resourceId: string; start: Date };
    expect(move.id).toBe('a1');
    expect(move.resourceId).toBe('ana');
    expect(move.start.toISOString()).toBe('2026-10-17T13:15:00.000Z');
  });

  it('moves it to the next professional with Alt and the right arrow', () => {
    const onMoveEvent = vi.fn();
    renderWithApp(
      <CalendarView {...props({ onMoveEvent, events: [event({ id: 'a1', movable: true })] })} />,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: /Gómez/ }), {
      key: 'ArrowRight',
      altKey: true,
    });

    const move = onMoveEvent.mock.calls[0]?.[0] as { resourceId: string; start: Date };
    expect(move.resourceId).toBe('beto');
    expect(move.start.toISOString()).toBe('2026-10-17T13:00:00.000Z');
  });

  it('ignores the arrows on an appointment that cannot be moved', () => {
    const onMoveEvent = vi.fn();
    renderWithApp(
      <CalendarView {...props({ onMoveEvent, events: [event({ id: 'a1', movable: false })] })} />,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: /Gómez/ }), {
      key: 'ArrowDown',
      altKey: true,
    });

    expect(onMoveEvent).not.toHaveBeenCalled();
  });

  it('moves with the pointer: the drop position decides the column and the time', () => {
    const onMoveEvent = vi.fn();
    renderWithApp(
      <CalendarView {...props({ onMoveEvent, events: [event({ id: 'a1', movable: true })] })} />,
    );
    const columns = screen.getByTestId('time-grid-columns');
    vi.spyOn(columns, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      width: 400,
      height: 1000,
      bottom: 1000,
      right: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const button = screen.getByRole('button', { name: /Gómez/ });

    fireEvent.pointerDown(button, { button: 0, pointerType: 'mouse', clientX: 50, clientY: 220 });
    fireEvent.pointerMove(window, { pointerType: 'mouse', clientX: 300, clientY: 292 });
    fireEvent.pointerUp(window, { pointerType: 'mouse', clientX: 300, clientY: 292 });

    expect(onMoveEvent).toHaveBeenCalledTimes(1);
    const move = onMoveEvent.mock.calls[0]?.[0] as { resourceId: string; start: Date };
    // The right half is the second column; 72 px lower is one hour later.
    expect(move.resourceId).toBe('beto');
    expect(move.start.toISOString()).toBe('2026-10-17T14:00:00.000Z');
  });

  it('treats a plain click as opening, not as a move', () => {
    const onMoveEvent = vi.fn();
    const onSelectEvent = vi.fn();
    renderWithApp(
      <CalendarView
        {...props({ onMoveEvent, onSelectEvent, events: [event({ id: 'a1', movable: true })] })}
      />,
    );
    const button = screen.getByRole('button', { name: /Gómez/ });

    fireEvent.pointerDown(button, { button: 0, pointerType: 'mouse', clientX: 50, clientY: 220 });
    fireEvent.pointerUp(window, { pointerType: 'mouse', clientX: 50, clientY: 220 });
    fireEvent.click(button);

    expect(onMoveEvent).not.toHaveBeenCalled();
    expect(onSelectEvent).toHaveBeenCalledWith('a1');
  });
});

describe('the week and month views', () => {
  it('shows seven day columns for a week, with the professional named on each appointment', () => {
    renderWithApp(
      <CalendarView {...props({ view: 'week', events: EVENTS.map(withResourceLabel) })} />,
    );

    expect(screen.getAllByRole('group', { name: /^Agenda del / })).toHaveLength(7);
    const saturday = screen.getByRole('group', { name: 'Agenda del sábado 17 de octubre' });
    expect(within(saturday).getAllByRole('button')).toHaveLength(2);
    expect(within(saturday).getByRole('button', { name: /Dra\. Ana Pérez/ })).toBeInTheDocument();
    const friday = screen.getByRole('group', { name: 'Agenda del viernes 16 de octubre' });
    expect(within(friday).queryAllByRole('button')).toHaveLength(0);
  });

  it('counts the appointments of each day in a month and opens the day when it is chosen', () => {
    const onSelectDay = vi.fn();
    renderWithApp(<CalendarView {...props({ view: 'month', onSelectDay })} />);

    const day = screen.getByRole('button', { name: /17 de octubre.*2 turnos/ });
    fireEvent.click(day);

    expect(onSelectDay).toHaveBeenCalledWith('2026-10-17');
    expect(screen.getByRole('button', { name: /16 de octubre.*sin turnos/i })).toBeInTheDocument();
  });

  it('marks a holiday in the month with its name', () => {
    renderWithApp(
      <CalendarView
        {...props({ view: 'month', closedDays: { '2026-10-12': 'Día de la Raza' } })}
      />,
    );

    expect(
      screen.getByRole('button', { name: /12 de octubre.*Día de la Raza/ }),
    ).toBeInTheDocument();
  });
});

describe('the list presentation (phones, and anybody who prefers a list)', () => {
  it('lists the appointments of the day in time order with their status as text', () => {
    renderWithApp(<CalendarView {...props({ presentation: 'list' })} />);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText('Gómez, Valentina')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('Confirmado')).toBeInTheDocument();
    expect(
      within(items[1] as HTMLElement).getByText('Pendiente de aprobación'),
    ).toBeInTheDocument();
  });

  it('groups a week by day and names the professional', () => {
    renderWithApp(
      <CalendarView
        {...props({ view: 'week', presentation: 'list', events: EVENTS.map(withResourceLabel) })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'sábado 17 de octubre' })).toBeInTheDocument();
    expect(screen.getByText('Dra. Ana Pérez')).toBeInTheDocument();
  });

  it('says plainly when there is nothing', () => {
    renderWithApp(<CalendarView {...props({ presentation: 'list', events: [] })} />);

    expect(screen.getByText('No hay turnos en este período.')).toBeInTheDocument();
  });

  it('opens an appointment from the list', () => {
    const onSelectEvent = vi.fn();
    renderWithApp(<CalendarView {...props({ presentation: 'list', onSelectEvent })} />);

    fireEvent.click(screen.getByRole('button', { name: /Ríos, Tomás/ }));

    expect(onSelectEvent).toHaveBeenCalledWith('b1');
  });
});

describe('accessibility', () => {
  it.each([
    ['day grid', { view: 'day' as const }],
    ['week grid', { view: 'week' as const }],
    ['month', { view: 'month' as const }],
    ['day list', { view: 'day' as const, presentation: 'list' as const }],
    ['week list', { view: 'week' as const, presentation: 'list' as const }],
  ])('has no WCAG violations in the %s', async (_name, overrides) => {
    const { container } = renderWithApp(
      <CalendarView
        {...props({
          ...overrides,
          events: EVENTS.map((item) => ({ ...item, movable: true })).map(withResourceLabel),
          onSelectSlot: vi.fn(),
          onMoveEvent: vi.fn(),
        })}
      />,
    );

    expect(await a11yViolations(container)).toEqual([]);
  });
});

function withResourceLabel(item: CalendarEvent): CalendarEvent {
  const label = RESOURCES.find((resource) => resource.id === item.resourceId)?.label;
  return label ? { ...item, resourceLabel: label } : item;
}
