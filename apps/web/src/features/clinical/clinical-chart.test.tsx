import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';
import { patient } from '../patients/fixtures.js';

import {
  CLINICAL_IDS,
  COLLEAGUE,
  addendum,
  draftNote,
  history,
  signedNote,
  timeline,
  timelineEntry,
} from './fixtures.js';

/**
 * The clinical chart of a patient: the timeline, the search, the anamnesis link, the versions
 * drawer, and the dialogs to annotate or mark an entry (clinical-records, CLN-02, CLN-04, CLN-05,
 * CLN-11). The application runs with its real router and a fake network.
 */
const ID = CLINICAL_IDS.patient;
const TIMELINE = `GET /api/patients/${ID}/clinical/timeline`;
const SEARCH = `GET /api/patients/${ID}/clinical/search`;

let current: RenderedApp | undefined;

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

type Handler = (url: string, init: RequestInit) => Response;

function openChart(
  routes: Record<string, Handler | Response> = {},
  roles: ('professional' | 'reception' | 'admin')[] = ['professional'],
) {
  current = renderApp({
    me: meFor(roles),
    path: `/patients/${ID}?tab=chart`,
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      [`GET /api/patients/${ID}`]: () => jsonResponse(patient({ id: ID })),
      [`GET /api/patients/${ID}/representatives`]: () =>
        jsonResponse({ minor: false, representatives: [] }),
      [TIMELINE]: () => jsonResponse(timeline()),
      ...routes,
    },
  });
  return current;
}

const queryOf = (url: string) => new URL(url, 'http://localhost').searchParams;

describe('who has the chart', () => {
  it('shows the tab to a professional and opens on it when the address says so', async () => {
    openChart();

    expect(
      await screen.findByRole('tab', { name: 'Historia clínica', selected: true }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Control de presión arterial')).toBeInTheDocument();
  });

  it('gives reception and administrators no tab and asks the server for nothing clinical', async () => {
    for (const role of ['reception', 'admin'] as const) {
      const view = openChart({}, [role]);
      await screen.findByRole('heading', { level: 1, name: 'Valentina Gómez' });

      expect(screen.queryByRole('tab', { name: 'Historia clínica' })).not.toBeInTheDocument();
      expect(view.requests.some((request) => request.includes('/clinical/'))).toBe(false);
      view.unmount();
    }
  });
});

describe('the timeline', () => {
  it('lists the entries newest first, with the author, the time and the addenda attached', async () => {
    const newer = timelineEntry({
      noteId: '0190a000-0000-7000-8000-0000000000d1',
      headline: 'Control posterior',
      signedAt: '2026-10-17T10:00:00.000Z',
      addenda: [
        addendum(),
        addendum({ id: '0190a000-0000-7000-8000-0000000000d2', text: 'Segunda addenda' }),
      ],
    });
    openChart({ [TIMELINE]: () => jsonResponse(timeline([newer, timelineEntry()])) });

    const list = await screen.findByRole('list', { name: 'Consultas del paciente' });
    const items = within(list)
      .getAllByRole('listitem')
      .filter((item) => item.hasAttribute('data-status'));

    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText('Control posterior')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('2 addendas')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('Segunda addenda')).toBeInTheDocument();
    expect(
      within(items[0] as HTMLElement).getAllByText('Motivo: Corrección del diagnóstico'),
    ).toHaveLength(2);
    expect(
      within(items[1] as HTMLElement).getByText('Dra. Lucía Paz Ferrer, 16/10/2026 09:30'),
    ).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByRole('link', { name: 'Abrir' })).toHaveAttribute(
      'href',
      `/notes/${CLINICAL_IDS.note}`,
    );
  });

  it('marks what is restricted to its author and what is read through sharing', async () => {
    openChart({
      [TIMELINE]: () =>
        jsonResponse(
          timeline([
            timelineEntry({ visibility: 'author_only' }),
            timelineEntry({
              noteId: '0190a000-0000-7000-8000-0000000000d3',
              basis: 'shared',
              author: COLLEAGUE,
            }),
          ]),
        ),
    });

    expect(await screen.findByText('Solo para su autor')).toBeInTheDocument();
    expect(screen.getByText('Lectura compartida')).toBeInTheDocument();
  });

  it('hides the entries marked in error until asked, then shows them struck through with the reason', async () => {
    const user = userEvent.setup();
    const wrong = timelineEntry({
      noteId: '0190a000-0000-7000-8000-0000000000d4',
      status: 'entered_in_error',
      headline: 'Paciente equivocado',
      errorReason: 'Se cargó en otro paciente',
    });
    const asked: string[] = [];
    openChart({
      [TIMELINE]: (url) => {
        asked.push(url);
        return jsonResponse(
          queryOf(url).get('includeErrors') === 'true'
            ? timeline([wrong, timelineEntry()])
            : timeline(),
        );
      },
    });
    await screen.findByText('Control de presión arterial');
    expect(screen.queryByText('Paciente equivocado')).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('checkbox', { name: 'Mostrar las entradas marcadas como error' }),
    );

    const headline = await screen.findByText('Paciente equivocado');
    expect(headline.closest('li')).toHaveAttribute('data-status', 'entered_in_error');
    expect(headline).toHaveClass('line-through');
    expect(screen.getByText('Motivo del error: Se cargó en otro paciente')).toBeInTheDocument();
    expect(screen.getByText('Marcada como error')).toBeInTheDocument();
    expect(asked.some((url) => queryOf(url).get('includeErrors') === 'true')).toBe(true);
  });

  it('links to the anamnesis without repeating it, and opens that tab', async () => {
    const user = userEvent.setup();
    openChart({
      [TIMELINE]: () => jsonResponse(timeline([timelineEntry()], { anamnesis: { version: 2 } })),
      [`GET /api/patients/${ID}/anamnesis`]: () => jsonResponse({ current: null }),
    });

    await user.click(await screen.findByRole('button', { name: 'Ver la anamnesis (versión 2)' }));

    expect(
      await screen.findByRole('tab', { name: 'Anamnesis', selected: true }),
    ).toBeInTheDocument();
  });

  it('says when there is no anamnesis yet', async () => {
    openChart();

    expect(await screen.findByText('Todavía no hay anamnesis registrada.')).toBeInTheDocument();
  });

  it('tells a professional who does not treat the patient that they have no access', async () => {
    openChart({ [TIMELINE]: () => problemResponse(403, 'forbidden') });

    expect(await screen.findByText('No tiene acceso a esta historia clínica')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nueva consulta' })).not.toBeInTheDocument();
  });

  it('shows an empty chart as waiting for the first consultation', async () => {
    openChart({ [TIMELINE]: () => jsonResponse(timeline([])) });

    expect(await screen.findByText('Todavía no hay consultas firmadas')).toBeInTheDocument();
  });

  it('loads older consultations with the cursor of the previous page', async () => {
    const user = userEvent.setup();
    const cursor = '0190a000-0000-7000-8000-0000000000d5';
    const older = timelineEntry({ noteId: cursor, headline: 'Consulta antigua' });
    const asked: string[] = [];
    openChart({
      [TIMELINE]: (url) => {
        asked.push(url);
        return jsonResponse(
          queryOf(url).get('before') === cursor
            ? timeline([older])
            : timeline([timelineEntry()], { nextCursor: cursor }),
        );
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Ver consultas anteriores' }));

    expect(await screen.findByText('Consulta antigua')).toBeInTheDocument();
    expect(screen.getByText('Control de presión arterial')).toBeInTheDocument();
    expect(asked.some((url) => queryOf(url).get('before') === cursor)).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Ver consultas anteriores' }),
    ).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const view = openChart({
      [TIMELINE]: () =>
        jsonResponse(
          timeline([timelineEntry({ addenda: [addendum()] })], { anamnesis: { version: 1 } }),
        ),
    });
    await screen.findByText('Control de presión arterial');

    expect(await a11yViolations(view.container)).toEqual([]);
  });
});

describe('the versions drawer', () => {
  it('lists the signed version and the addenda with their hashes, in order', async () => {
    const user = userEvent.setup();
    openChart({ [`GET /api/notes/${CLINICAL_IDS.note}/versions`]: () => jsonResponse(history()) });

    await user.click(await screen.findByRole('button', { name: 'Versiones' }));

    const drawer = await screen.findByRole('dialog', { name: 'Versiones de la nota' });
    const items = await within(drawer).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Nota firmada (versión 1)');
    expect(items[0]).toHaveTextContent('Huella bbbbbbbbbbbbbbbb');
    expect(items[1]).toHaveTextContent('Addenda: Corrección');
    expect(items[1]).toHaveTextContent('Dr. Mateo Ruiz');
    expect(items[1]).toHaveTextContent('Corrección del diagnóstico');
  });
});

describe('the search of this record', () => {
  it('finds a term, shows the words around it and says which part was an addendum', async () => {
    const user = userEvent.setup();
    const asked: string[] = [];
    openChart({
      [SEARCH]: (url) => {
        asked.push(url);
        return jsonResponse({
          hits: [
            {
              noteId: CLINICAL_IDS.note,
              encounterId: CLINICAL_IDS.encounter,
              templateKind: 'general',
              author: { professionalId: CLINICAL_IDS.author, name: 'Dra. Lucía Paz Ferrer' },
              signedAt: '2026-10-16T12:30:00.000Z',
              snippet: '…paciente con HIPERTENSIÓN arterial leve…',
              inAddendum: true,
            },
          ],
          scanned: 12,
        });
      },
    });

    await user.type(await screen.findByLabelText('Texto a buscar'), 'hipertension');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));

    const results = await screen.findByRole('region', { name: 'Resultados de la búsqueda' });
    expect(
      within(results).getByText('1 coincidencia en 12 entradas revisadas.'),
    ).toBeInTheDocument();
    expect(
      within(results).getByText('…paciente con HIPERTENSIÓN arterial leve…'),
    ).toBeInTheDocument();
    expect(within(results).getByText('En una addenda')).toBeInTheDocument();
    expect(
      within(results).getByRole('link', { name: /Consulta general, 16\/10\/2026/ }),
    ).toHaveAttribute('href', `/notes/${CLINICAL_IDS.note}`);
    expect(queryOf(asked[0] ?? '').get('q')).toBe('hipertension');
  });

  it('sends the date range', async () => {
    const user = userEvent.setup();
    const asked: string[] = [];
    openChart({
      [SEARCH]: (url) => {
        asked.push(url);
        return jsonResponse({ hits: [], scanned: 0 });
      },
    });

    await user.type(await screen.findByLabelText('Texto a buscar'), 'tos');
    await user.type(screen.getByLabelText('Desde'), '2026-01-01');
    await user.type(screen.getByLabelText('Hasta'), '2026-03-31');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));

    await waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    expect(queryOf(asked[0] ?? '').get('from')).toBe('2026-01-01');
    expect(queryOf(asked[0] ?? '').get('to')).toBe('2026-03-31');
    expect(
      await screen.findByText('No hay coincidencias en las 0 entradas revisadas.'),
    ).toBeInTheDocument();
  });

  it('asks for at least two letters without calling the server', async () => {
    const user = userEvent.setup();
    const view = openChart();

    await user.type(await screen.findByLabelText('Texto a buscar'), 'a');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));

    expect(await screen.findByText('Escriba al menos dos letras.')).toBeInTheDocument();
    expect(view.requests.some((request) => request.includes('/clinical/search'))).toBe(false);
  });

  it('asks for a date range when the record is too long to search at once', async () => {
    const user = userEvent.setup();
    openChart({
      [SEARCH]: () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            code: 'validation_failed',
            i18nKey: 'errors.validation_failed',
            requestId: 'req-1',
            errors: [{ path: 'from', i18nKey: 'clinical.search.range_required' }],
          }),
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
    });

    await user.type(await screen.findByLabelText('Texto a buscar'), 'tos');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));

    expect(
      await screen.findByText(
        'La historia es muy extensa: indique un rango de fechas para buscar.',
      ),
    ).toBeInTheDocument();
  });

  it('says it searches this patient only', async () => {
    openChart();

    expect(await screen.findByText(/Busca solo en este paciente/)).toBeInTheDocument();
  });
});

describe('starting a consultation', () => {
  it('opens a draft with the chosen template and takes the professional to the editor', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const created = draftNote({ templateKind: 'psychology' });
    openChart({
      'GET /api/clinical/templates': () =>
        jsonResponse({
          templates: [
            {
              kind: 'general',
              version: 1,
              labelKey: 'clinical.template.general',
              requiredFields: ['reasonForConsultation'],
            },
            {
              kind: 'psychology',
              version: 1,
              labelKey: 'clinical.template.psychology',
              requiredFields: ['sessionDate'],
            },
          ],
        }),
      'POST /api/encounters': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(created, 201);
      },
      [`GET /api/notes/${created.id}`]: () => jsonResponse(created),
    });

    await user.click(await screen.findByRole('button', { name: 'Nueva consulta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva consulta' });
    await user.click(await within(dialog).findByRole('radio', { name: 'Psicología' }));
    await user.click(
      within(dialog).getByRole('checkbox', { name: /Solo yo puedo leer esta nota/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Empezar la consulta' }));

    expect(await screen.findByLabelText(/Fecha de la sesión/)).toBeInTheDocument();
    expect(bodies).toEqual([
      { patientId: ID, templateKind: 'psychology', visibility: 'author_only' },
    ]);
  });

  it('offers no way to start for a reader without the write permission', async () => {
    openChart();

    await screen.findByText('Control de presión arterial');
    // A professional can; the button is for clinical.note.write, which only professionals hold.
    expect(screen.getByRole('button', { name: 'Nueva consulta' })).toBeInTheDocument();
  });
});

describe('a note, read', () => {
  const NOTE_URL = `GET /api/notes/${CLINICAL_IDS.note}`;

  function openNote(
    note = signedNote({ addenda: [addendum()] }),
    roles: ('professional' | 'reception')[] = ['professional'],
    extra: Record<string, Handler | Response> = {},
  ) {
    current = renderApp({
      me: meFor(roles),
      path: `/notes/${CLINICAL_IDS.note}`,
      boot: bootFor('Centro Médico Aillu'),
      routes: {
        [NOTE_URL]: () => jsonResponse(note),
        [`GET /api/patients/${ID}`]: () => jsonResponse(patient({ id: ID })),
        ...extra,
      },
    });
    return current;
  }

  it('shows the original with the addenda after it, who signed and the fingerprint', async () => {
    openNote();

    expect(await screen.findByText('Nota original')).toBeInTheDocument();
    expect(screen.getByText('Control de presión arterial')).toBeInTheDocument();
    expect(
      screen.getByText(/Firmada por Dra\. Lucía Paz Ferrer el 16\/10\/2026 a las 09:30/),
    ).toBeInTheDocument();
    const addenda = screen
      .getByRole('heading', { name: 'Addendas' })
      .closest('section') as HTMLElement;
    expect(
      within(addenda).getByText('El diagnóstico es hipertensión moderada'),
    ).toBeInTheDocument();
    expect(screen.getByText('Huella de la nota firmada')).toBeInTheDocument();
  });

  it('offers only the actions the server allowed', async () => {
    openNote(
      signedNote({
        access: {
          basis: 'shared',
          canEdit: false,
          canSign: false,
          canAddAddendum: false,
          canMarkError: false,
          rectificationOnly: false,
        },
      }),
    );

    await screen.findByText('Nota original');

    expect(screen.queryByRole('button', { name: 'Agregar addenda' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Marcar como error' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/acceso compartido de la organización: solo lectura/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ver versiones' })).toBeInTheDocument();
  });

  it('shows the forbidden state to reception, and asks the server for nothing', async () => {
    const view = openNote(signedNote(), ['reception']);

    expect(await screen.findByText('No tiene acceso a esta sección')).toBeInTheDocument();
    expect(view.requests.some((request) => request.includes('/notes/'))).toBe(false);
  });

  it('says an entry does not exist (or cannot be opened) in the same words', async () => {
    current = renderApp({
      me: meFor(['professional']),
      path: `/notes/${CLINICAL_IDS.note}`,
      boot: bootFor('Centro Médico Aillu'),
      routes: { [NOTE_URL]: () => problemResponse(404, 'not_found') },
    });

    expect(await screen.findByText('No se encontró la nota')).toBeInTheDocument();
  });

  it('adds an addendum with a reason, and shows it after the original', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const after = signedNote({
      addenda: [
        addendum({
          author: { professionalId: CLINICAL_IDS.author, name: 'Dra. Lucía Paz Ferrer' },
          text: 'Texto nuevo',
          reason: 'Dato omitido',
        }),
      ],
    });
    openNote(signedNote(), ['professional'], {
      [`POST /api/notes/${CLINICAL_IDS.note}/addenda`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(after, 201);
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Agregar addenda' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar una addenda' });
    await user.click(within(dialog).getByRole('button', { name: 'Agregar addenda' }));
    expect(within(dialog).getAllByText('Este dato es obligatorio.')).toHaveLength(2);
    expect(bodies).toEqual([]);
    await user.type(within(dialog).getByLabelText('Motivo'), 'Dato omitido');
    await user.type(within(dialog).getByLabelText('Texto de la addenda'), 'Texto nuevo');
    await user.click(within(dialog).getByRole('button', { name: 'Agregar addenda' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Agregar una addenda' })).not.toBeInTheDocument();
    });
    expect(bodies).toEqual([{ kind: 'correction', reason: 'Dato omitido', text: 'Texto nuevo' }]);
    expect(await screen.findByText('Texto nuevo')).toBeInTheDocument();
  });

  it('offers only the rectification while the organization is read-only', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    openNote(
      signedNote({
        access: {
          basis: 'author',
          canEdit: false,
          canSign: false,
          canAddAddendum: true,
          canMarkError: false,
          rectificationOnly: true,
        },
      }),
      ['professional'],
      {
        [`POST /api/notes/${CLINICAL_IDS.note}/addenda`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(signedNote(), 201);
        },
      },
    );

    await user.click(await screen.findByRole('button', { name: 'Agregar addenda' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar una addenda' });

    expect(within(dialog).getByRole('radio', { name: /Corrección/ })).toBeDisabled();
    expect(
      within(dialog).getByRole('radio', { name: /Rectificación pedida por el paciente/ }),
    ).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Marcar como error' })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Motivo'), 'Pedido del paciente');
    await user.type(within(dialog).getByLabelText('Texto de la addenda'), 'Alergia a la dipirona');
    await user.click(within(dialog).getByRole('button', { name: 'Agregar addenda' }));
    await waitFor(() => {
      expect(bodies).toEqual([
        { kind: 'rectification', reason: 'Pedido del paciente', text: 'Alergia a la dipirona' },
      ]);
    });
  });

  it('tells who may add an addendum when the server refuses', async () => {
    const user = userEvent.setup();
    openNote(signedNote(), ['professional'], {
      [`POST /api/notes/${CLINICAL_IDS.note}/addenda`]: () => problemResponse(403, 'forbidden'),
    });

    await user.click(await screen.findByRole('button', { name: 'Agregar addenda' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar una addenda' });
    await user.type(within(dialog).getByLabelText('Motivo'), 'Motivo');
    await user.type(within(dialog).getByLabelText('Texto de la addenda'), 'Texto');
    await user.click(within(dialog).getByRole('button', { name: 'Agregar addenda' }));

    expect(await within(dialog).findByText('No tiene permiso para hacer esto')).toBeInTheDocument();
  });

  it('marks an entry as error only with a reason, and then shows it as such', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const marked = signedNote({
      status: 'entered_in_error',
      error: {
        reason: 'Paciente equivocado',
        markedBy: { professionalId: CLINICAL_IDS.author, name: 'Dra. Lucía Paz Ferrer' },
        markedAt: '2026-10-17T10:00:00.000Z',
      },
      access: {
        basis: 'author',
        canEdit: false,
        canSign: false,
        canAddAddendum: false,
        canMarkError: false,
        rectificationOnly: false,
      },
    });
    openNote(signedNote(), ['professional'], {
      [`POST /api/notes/${CLINICAL_IDS.note}/entered-in-error`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(marked);
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Marcar como error' }));
    const dialog = await screen.findByRole('dialog', { name: 'Marcar como error' });
    await user.click(within(dialog).getByRole('button', { name: 'Marcar como error' }));
    expect(within(dialog).getByText('Este dato es obligatorio.')).toBeInTheDocument();
    expect(bodies).toEqual([]);
    await user.type(within(dialog).getByLabelText('Motivo'), 'Paciente equivocado');
    await user.click(within(dialog).getByRole('button', { name: 'Marcar como error' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ reason: 'Paciente equivocado' }]);
    });
    expect(
      await screen.findByText(/Esta entrada se marcó como error por Dra\. Lucía Paz Ferrer/),
    ).toBeInTheDocument();
    expect(screen.getByText('Motivo del error: Paciente equivocado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agregar addenda' })).not.toBeInTheDocument();
  });

  it('has no accessibility violations, with the dialog open', async () => {
    const user = userEvent.setup();
    const view = openNote();
    await user.click(await screen.findByRole('button', { name: 'Agregar addenda' }));
    await screen.findByRole('dialog', { name: 'Agregar una addenda' });

    expect(await a11yViolations(view.baseElement)).toEqual([]);
  });
});

describe('the drafts of a professional', () => {
  it('lists them with the patient and a way to continue', async () => {
    current = renderApp({
      me: meFor(['professional']),
      path: '/drafts',
      boot: bootFor('Centro Médico Aillu'),
      routes: {
        'GET /api/clinical/drafts': () =>
          jsonResponse({
            drafts: [
              {
                noteId: CLINICAL_IDS.note,
                encounterId: CLINICAL_IDS.encounter,
                patientId: ID,
                patientName: 'Gómez, Valentina',
                templateKind: 'psychology',
                visibility: 'author_only',
                draftRevision: 3,
                createdAt: '2026-10-16T12:00:00.000Z',
                updatedAt: '2026-10-17T08:15:00.000Z',
              },
            ],
          }),
      },
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Borradores' }),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Sus borradores' });
    expect(within(list).getByText('Gómez, Valentina')).toBeInTheDocument();
    expect(within(list).getByText('Psicología')).toBeInTheDocument();
    expect(within(list).getByText('Solo para su autor')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Continuar' })).toHaveAttribute(
      'href',
      `/notes/${CLINICAL_IDS.note}`,
    );
  });

  it('shows an empty list as having nothing pending', async () => {
    current = renderApp({
      me: meFor(['professional']),
      path: '/drafts',
      boot: bootFor('Centro Médico Aillu'),
      routes: { 'GET /api/clinical/drafts': () => jsonResponse({ drafts: [] }) },
    });

    expect(await screen.findByText('No tiene borradores')).toBeInTheDocument();
  });

  it('is not for reception', async () => {
    current = renderApp({
      me: meFor(['reception']),
      path: '/drafts',
      boot: bootFor('Centro Médico Aillu'),
    });

    expect(await screen.findByText('No tiene acceso a esta sección')).toBeInTheDocument();
  });
});

describe('the address a consultation is started from', () => {
  it('opens the encounter tied to the appointment and goes to the editor', async () => {
    const bodies: unknown[] = [];
    const created = draftNote();
    const appointment = '0190a000-0000-7000-8000-0000000000f9';
    current = renderApp({
      me: meFor(['professional']),
      path: `/encounters/new?patientId=${ID}&appointmentId=${appointment}`,
      boot: bootFor('Centro Médico Aillu'),
      routes: {
        [`GET /api/patients/${ID}`]: () => jsonResponse(patient({ id: ID })),
        'GET /api/clinical/templates': () =>
          jsonResponse({
            templates: [
              {
                kind: 'general',
                version: 1,
                labelKey: 'clinical.template.general',
                requiredFields: ['reasonForConsultation'],
              },
            ],
          }),
        'POST /api/encounters': (_url: string, init: RequestInit) => {
          bodies.push(jsonBody(init));
          return jsonResponse(created, 201);
        },
        [`GET /api/notes/${created.id}`]: () => jsonResponse(created),
      },
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Empezar la consulta' }));

    expect(await screen.findByLabelText(/Motivo de la consulta/)).toBeInTheDocument();
    expect(bodies).toEqual([
      { patientId: ID, templateKind: 'general', appointmentId: appointment },
    ]);
  });

  it('says the patient is missing when the address does not name one', async () => {
    current = renderApp({
      me: meFor(['professional']),
      path: '/encounters/new',
      boot: bootFor('Centro Médico Aillu'),
    });

    expect(
      await screen.findByText('Falta indicar el paciente de la consulta.'),
    ).toBeInTheDocument();
  });
});
