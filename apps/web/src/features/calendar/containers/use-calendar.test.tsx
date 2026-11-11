import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { fakeFetch, jsonResponse, renderWithApp } from '../../../shared/test/render.js';

import { useCalendar } from './use-calendar.js';

const BA = 'America/Argentina/Buenos_Aires';
const ANA = '0190a000-0000-7000-8000-00000000000a';
const BETO = '0190a000-0000-7000-8000-00000000000b';
const CENTRO = '0190a000-0000-7000-8000-0000000000c1';

function Probe({
  view = 'day',
  professionalIds = [],
  locationId,
}: {
  view?: 'day' | 'week' | 'month';
  professionalIds?: string[];
  locationId?: string;
}) {
  const [date, setDate] = useState('2026-10-17');
  const calendar = useCalendar({ view, date, timeZone: BA, professionalIds, locationId });
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setDate('2026-10-18');
        }}
      >
        next
      </button>
      <p data-testid="range">{`${calendar.range.from}|${calendar.range.to}`}</p>
      <p data-testid="status">{calendar.feed.isSuccess ? 'ready' : 'loading'}</p>
      <p data-testid="count">{String(calendar.feed.data?.appointments.length ?? -1)}</p>
      <p data-testid="truncated">{String(calendar.feed.data?.truncated ?? false)}</p>
    </div>
  );
}

function feed(extra: Record<string, unknown> = {}) {
  return jsonResponse({ appointments: [], blocks: [], holidays: [], ...extra });
}

function setup(ui: React.ReactElement, response = feed()) {
  const urls: string[] = [];
  const result = renderWithApp(ui, {
    fetch: fakeFetch({
      'GET /api/appointments': (url) => {
        urls.push(url);
        return response.clone();
      },
    }),
  });
  return { ...result, urls };
}

describe('useCalendar', () => {
  it('asks for the local day of the location, the chosen professionals and the location', async () => {
    const { urls } = setup(<Probe professionalIds={[BETO, ANA]} locationId={CENTRO} />);

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('ready');
    });

    const query = new URL(urls[0] ?? '', 'http://x').searchParams;
    expect(query.get('from')).toBe('2026-10-17T03:00:00.000Z');
    expect(query.get('to')).toBe('2026-10-18T03:00:00.000Z');
    expect(query.get('professionalIds')).toBe(`${ANA},${BETO}`.split(',').sort().join(','));
    expect(query.get('locationId')).toBe(CENTRO);
  });

  it('omits the filters that are not chosen, so the server decides who is visible', async () => {
    const { urls } = setup(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('ready');
    });

    const query = new URL(urls[0] ?? '', 'http://x').searchParams;
    expect(query.has('professionalIds')).toBe(false);
    expect(query.has('locationId')).toBe(false);
  });

  it('covers Monday to the next Monday for the week view', async () => {
    const { urls } = setup(<Probe view="week" />);

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('ready');
    });

    const query = new URL(urls[0] ?? '', 'http://x').searchParams;
    expect(query.get('from')).toBe('2026-10-12T03:00:00.000Z');
    expect(query.get('to')).toBe('2026-10-19T03:00:00.000Z');
  });

  it('asks again for the new window when the day changes', async () => {
    const { urls } = setup(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('ready');
    });

    fireEvent.click(screen.getByRole('button', { name: 'next' }));

    await waitFor(() => {
      expect(urls).toHaveLength(2);
    });
    expect(new URL(urls[1] ?? '', 'http://x').searchParams.get('from')).toBe(
      '2026-10-18T03:00:00.000Z',
    );
    expect(screen.getByTestId('range')).toHaveTextContent('2026-10-18T03:00:00.000Z');
  });

  it('tells when the server cut the answer short, and defaults to complete', async () => {
    const { unmount } = setup(<Probe />, feed({ truncated: true }));
    await waitFor(() => {
      expect(screen.getByTestId('truncated')).toHaveTextContent('true');
    });
    unmount();

    setup(<Probe />, feed());
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('ready');
    });
    expect(screen.getByTestId('truncated')).toHaveTextContent('false');
  });
});
