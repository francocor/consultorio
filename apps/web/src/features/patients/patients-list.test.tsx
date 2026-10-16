import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../shared/test/render.js';

import { PATIENT_IDS, SUMMARIES, summary } from './fixtures.js';

type Handler = (url: string, init: RequestInit) => Response;

function open(routes: Record<string, Handler> = {}, me = meFor(['reception']), path = '/patients') {
  return renderApp({
    me,
    path,
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/patients': () => jsonResponse({ patients: SUMMARIES, nextCursor: null }),
      ...routes,
    },
  });
}

describe('patient list', () => {
  it('shows each patient with document, age and phone, and the safety alert without detail', async () => {
    const app = open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Pacientes' })).toBeInTheDocument();
    const valentina = (await screen.findByText('Gómez, Valentina')).closest('li');
    const row = within(valentina as HTMLElement);
    expect(row.getByText('99.000.001')).toBeInTheDocument();
    expect(row.getByText(/años/)).toBeInTheDocument();
    expect(row.getByText('Tel. +54 11 0000 1234')).toBeInTheDocument();
    expect(row.queryByText('Consultar con el profesional')).not.toBeInTheDocument();

    const santiago = screen.getByText('Rodríguez, Santiago').closest('li');
    expect(
      within(santiago as HTMLElement).getByText('Consultar con el profesional'),
    ).toBeInTheDocument();
    expect(screen.getByText('3 pacientes')).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('a patient without a document says so', async () => {
    open();

    const ian = (await screen.findByText('Navarro, Ian')).closest('li');
    expect(within(ian as HTMLElement).getByText('Sin documento')).toBeInTheDocument();
  });

  it('opens the record of a patient', async () => {
    open();

    const link = await screen.findByRole('link', { name: 'Gómez, Valentina' });
    expect(link).toHaveAttribute('href', `/patients/${PATIENT_IDS.valentina}`);
  });

  it('searches as the person types, asking the server and not filtering locally', async () => {
    const user = userEvent.setup();
    const asked: string[] = [];
    open({
      'GET /api/patients': (url) => {
        asked.push(url);
        const query = new URL(url, 'http://x').searchParams.get('q');
        return jsonResponse({
          patients: query === 'rodri' ? [SUMMARIES[1] ?? summary()] : SUMMARIES,
          nextCursor: null,
        });
      },
    });
    await screen.findByText('Gómez, Valentina');

    await user.type(screen.getByRole('searchbox', { name: 'Buscar un paciente' }), 'rodri');

    await waitFor(() => {
      expect(screen.queryByText('Gómez, Valentina')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Rodríguez, Santiago')).toBeInTheDocument();
    // One request for what was typed, not one per keystroke.
    expect(asked.filter((url) => url.includes('q=')).length).toBeLessThanOrEqual(2);
    expect(asked.some((url) => url.includes('q=rodri'))).toBe(true);
  });

  it('filters by status: inactive patients are not in the default list', async () => {
    const user = userEvent.setup();
    const asked: string[] = [];
    open({
      'GET /api/patients': (url) => {
        asked.push(url);
        return jsonResponse({
          patients: url.includes('status=inactive')
            ? [summary({ familyName: 'Silva', givenNames: 'Agustín', status: 'inactive' })]
            : SUMMARIES,
          nextCursor: null,
        });
      },
    });
    await screen.findByText('Gómez, Valentina');
    expect(asked[0]).toContain('status=active');

    await user.selectOptions(screen.getByLabelText('Mostrar'), 'inactive');

    const former = (await screen.findByText('Silva, Agustín')).closest('li');
    expect(within(former as HTMLElement).getByText('Inactivo')).toBeInTheDocument();
  });

  it('explains when a search finds nothing and offers to clear it', async () => {
    const user = userEvent.setup();
    open({
      'GET /api/patients': (url) =>
        jsonResponse({
          patients: url.includes('q=zzz') ? [] : SUMMARIES,
          nextCursor: null,
        }),
    });
    await screen.findByText('Gómez, Valentina');

    await user.type(screen.getByRole('searchbox', { name: 'Buscar un paciente' }), 'zzz');

    expect(
      await screen.findByRole('heading', { name: 'No encontramos pacientes' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No hay resultados para “zzz”/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limpiar la búsqueda' }));
    expect(await screen.findByText('Gómez, Valentina')).toBeInTheDocument();
  });

  it('a new organization sees what the screen is for and the first action', async () => {
    open({ 'GET /api/patients': () => jsonResponse({ patients: [], nextCursor: null }) });

    expect(
      await screen.findByRole('heading', { name: 'Todavía no hay pacientes' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Nuevo paciente' })[0]).toHaveAttribute(
      'href',
      '/patients/new',
    );
  });

  it('loads more with the cursor the server gave', async () => {
    const user = userEvent.setup();
    const asked: string[] = [];
    open({
      'GET /api/patients': (url) => {
        asked.push(url);
        return url.includes('cursor=next-1')
          ? jsonResponse({
              patients: [
                summary({
                  id: PATIENT_IDS.isabella,
                  familyName: 'Domínguez',
                  givenNames: 'Isabella',
                }),
              ],
              nextCursor: null,
            })
          : jsonResponse({ patients: SUMMARIES, nextCursor: 'next-1' });
      },
    });
    await screen.findByText('Gómez, Valentina');

    await user.click(screen.getByRole('button', { name: 'Ver más pacientes' }));

    expect(await screen.findByText('Domínguez, Isabella')).toBeInTheDocument();
    expect(screen.getByText('Gómez, Valentina')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ver más pacientes' })).not.toBeInTheDocument();
    expect(screen.getByText('4 pacientes')).toBeInTheDocument();
  });

  it('shows a retryable error', async () => {
    const user = userEvent.setup();
    let fail = true;
    open({
      'GET /api/patients': () =>
        fail
          ? problemResponse(500, 'internal_error')
          : jsonResponse({ patients: SUMMARIES, nextCursor: null }),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Código de referencia');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('Gómez, Valentina')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const app = open();
    await screen.findByText('Gómez, Valentina');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
