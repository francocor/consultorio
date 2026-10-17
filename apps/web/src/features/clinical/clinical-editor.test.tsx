import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { problemResponse } from '../../shared/test/render.js';

import { autosaveConfig } from './components/ClinicalEditor.js';
import { CLINICAL_IDS, draftNote } from './fixtures.js';
import { draftServer } from './test-server.js';

/**
 * The editor of a draft (clinical-records, "Draft, signing and immutability"). The component is
 * rendered through the real router and providers, with a fake network that behaves like the API:
 * every save carries the revision it was based on and gets the next one back.
 */
const NOTE = CLINICAL_IDS.note;
const ENCOUNTER = CLINICAL_IDS.encounter;
const PUT = `PUT /api/encounters/${ENCOUNTER}/note/draft`;
const server = draftServer;

let current: RenderedApp | undefined;

beforeAll(() => {
  autosaveConfig.delayMs = 150;
});

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(
  routes: ReturnType<typeof draftServer>['routes'],
  role: 'professional' = 'professional',
) {
  current = renderApp({
    me: meFor([role]),
    path: `/notes/${NOTE}`,
    boot: bootFor('Centro Médico Aillu'),
    routes,
  });
  return current;
}

describe('the editor of a draft', () => {
  it('opens the template of the note with its required field marked, and says it is saved', async () => {
    const { routes } = server(draftNote({ content: { reasonForConsultation: 'Control' } }));
    open(routes);

    const reason = await screen.findByLabelText(/Motivo de la consulta/);

    expect(reason).toHaveValue('Control');
    expect(screen.getByText('obligatorio')).toBeInTheDocument();
    expect(screen.getByText('Guardado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Firmar nota' })).toBeEnabled();
    expect(screen.getByText('Borrador')).toBeInTheDocument();
  });

  it('saves by itself after the last change, based on the revision it started from, and keeps the chain', async () => {
    const user = userEvent.setup();
    const { state, routes } = server();
    open(routes);

    await user.type(await screen.findByLabelText(/Motivo de la consulta/), 'Dolor de cabeza');
    await waitFor(() => {
      expect(state.saves).toHaveLength(1);
    });
    await user.type(screen.getByLabelText('Síntomas o hallazgos'), 'Desde hace dos días');
    await waitFor(() => {
      expect(state.saves).toHaveLength(2);
    });

    expect(state.saves[0]).toEqual({
      content: { reasonForConsultation: 'Dolor de cabeza' },
      baseRevision: 0,
    });
    expect(state.saves[1]).toEqual({
      content: { reasonForConsultation: 'Dolor de cabeza', symptoms: 'Desde hace dos días' },
      baseRevision: 1,
    });
    await waitFor(() => {
      expect(screen.getByText('Guardado')).toBeInTheDocument();
    });
  });

  it('does not send a value that is wrong in itself, and says so', async () => {
    const user = userEvent.setup();
    const { state, routes } = server(
      draftNote({ templateKind: 'nutrition', content: { weightKg: 70, heightM: 1.75 } }),
    );
    open(routes);

    const weight = await screen.findByLabelText(/Peso \(kg\)/);
    await user.clear(weight);
    await user.type(weight, '-5');

    await waitFor(() => {
      expect(
        screen.getByText('Hay valores incorrectos: corríjalos para que se guarde.'),
      ).toBeInTheDocument();
    });
    expect(state.saves).toEqual([]);
  });

  it('carries the restriction to the author in the draft', async () => {
    const user = userEvent.setup();
    const { state, routes } = server();
    open(routes);

    await user.click(await screen.findByRole('checkbox', { name: /Solo yo puedo leer esta nota/ }));
    await user.type(screen.getByLabelText(/Motivo de la consulta/), 'Reservada');

    await waitFor(() => {
      expect(state.saves.at(-1)).toMatchObject({ visibility: 'author_only' });
    });
  });
});

describe('two screens editing the same draft', () => {
  it('stops at a newer revision, overwrites nothing, and lets the author choose', async () => {
    const user = userEvent.setup();
    const { state, routes } = server();
    open(routes);
    const reason = await screen.findByLabelText(/Motivo de la consulta/);
    // Another tab saved first.
    state.note = {
      ...state.note,
      content: { reasonForConsultation: 'Desde la otra pestaña' },
      draftRevision: 1,
    };

    await user.type(reason, 'Mi texto');

    expect(await screen.findByText('Esta nota se guardó desde otra pantalla')).toBeInTheDocument();
    expect(state.note.content).toEqual({ reasonForConsultation: 'Desde la otra pestaña' });
    expect(screen.getByRole('button', { name: 'Ver la versión guardada' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conservar mis cambios' })).toBeInTheDocument();
    // Nothing more is sent while the decision is pending.
    const sent = state.saves.length;
    await user.type(reason, ' más');
    expect(state.saves).toHaveLength(sent);
  });

  it('shows the saved version when the author takes it', async () => {
    const user = userEvent.setup();
    const { state, routes } = server();
    open(routes);
    const reason = await screen.findByLabelText(/Motivo de la consulta/);
    state.note = {
      ...state.note,
      content: { reasonForConsultation: 'Desde la otra pestaña' },
      draftRevision: 1,
    };
    await user.type(reason, 'Mi texto');

    await user.click(await screen.findByRole('button', { name: 'Ver la versión guardada' }));

    await waitFor(() => {
      expect(screen.getByLabelText(/Motivo de la consulta/)).toHaveValue('Desde la otra pestaña');
    });
    expect(screen.queryByText('Esta nota se guardó desde otra pantalla')).not.toBeInTheDocument();
  });

  it('sends what is on screen, based on the newer revision, when the author keeps it', async () => {
    const user = userEvent.setup();
    const { state, routes } = server();
    open(routes);
    const reason = await screen.findByLabelText(/Motivo de la consulta/);
    state.note = {
      ...state.note,
      content: { reasonForConsultation: 'Desde la otra pestaña' },
      draftRevision: 1,
    };
    await user.type(reason, 'Mi texto');

    await user.click(await screen.findByRole('button', { name: 'Conservar mis cambios' }));

    await waitFor(() => {
      expect(state.note.content).toEqual({ reasonForConsultation: 'Mi texto' });
    });
    expect(state.note.draftRevision).toBe(2);
    expect(state.saves.at(-1)).toMatchObject({ baseRevision: 1 });
  });

  it('says the note is no longer a draft when it was signed elsewhere', async () => {
    const user = userEvent.setup();
    const { state, routes } = server();
    routes[PUT] = () => problemResponse(409, 'conflict');
    open(routes);

    await user.type(await screen.findByLabelText(/Motivo de la consulta/), 'Tarde');

    expect(await screen.findByText('Esta nota ya no es un borrador')).toBeInTheDocument();
    expect(state.saves).toEqual([]);
  });
});

describe('signing', () => {
  it('saves first, asks for confirmation with the warning about immutability, then signs and locks the note', async () => {
    const user = userEvent.setup();
    const { state, routes } = server(draftNote({ content: { reasonForConsultation: 'Control' } }));
    open(routes);
    await user.type(await screen.findByLabelText('Síntomas o hallazgos'), 'Tos');

    await user.click(screen.getByRole('button', { name: 'Firmar nota' }));

    const dialog = await screen.findByRole('alertdialog', { name: '¿Firmar esta nota?' });
    expect(within(dialog).getByText(/no se puede modificar ni borrar/)).toBeInTheDocument();
    expect(state.saves).toHaveLength(1);
    expect(state.signs).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Firmar definitivamente' }));

    await waitFor(() => {
      expect(state.signs).toEqual([{ expectedRevision: 1 }]);
    });
    expect(await screen.findByText('Firmada')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Motivo de la consulta/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Firmar nota' })).not.toBeInTheDocument();
  });

  it('does not ask for confirmation when a required field is missing, and names it', async () => {
    const user = userEvent.setup();
    const { state, routes } = server(draftNote({ content: { symptoms: 'Tos' } }));
    open(routes);

    await user.click(await screen.findByRole('button', { name: 'Firmar nota' }));

    expect(await screen.findByText('Faltan datos para firmar')).toBeInTheDocument();
    expect(
      screen.getAllByText(/Motivo de la consulta: Este dato es obligatorio/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(state.signs).toEqual([]);
  });

  it('shows what the server refused when it disagrees (a rule only it applies)', async () => {
    const user = userEvent.setup();
    const { routes } = server(draftNote({ content: { reasonForConsultation: 'Control' } }));
    routes[`POST /api/notes/${NOTE}/sign`] = () =>
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          code: 'validation_failed',
          i18nKey: 'errors.validation_failed',
          requestId: 'req-1',
          errors: [{ path: 'reasonForConsultation', i18nKey: 'validation.required' }],
        }),
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      );
    open(routes);

    await user.click(await screen.findByRole('button', { name: 'Firmar nota' }));
    await user.click(await screen.findByRole('button', { name: 'Firmar definitivamente' }));

    expect(await screen.findByText('Faltan datos para firmar')).toBeInTheDocument();
  });

  it('asks for a follow-up note on a psychology session with high risk before it can be signed', async () => {
    const user = userEvent.setup();
    const { state, routes } = server(
      draftNote({
        templateKind: 'psychology',
        content: { sessionDate: '2026-05-04', modality: 'in_person', risk: 'high' },
      }),
    );
    open(routes);

    expect(
      await screen.findByText(/El riesgo es alto\. Escriba la nota de seguimiento/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Firmar nota' }));

    expect(await screen.findByText('Faltan datos para firmar')).toBeInTheDocument();
    expect(state.signs).toEqual([]);
  });
});

describe('a draft that cannot be edited', () => {
  it('is read without an editor when the organization is read-only', async () => {
    const { routes } = server(
      draftNote({
        content: { reasonForConsultation: 'Control' },
        access: {
          basis: 'author',
          canEdit: false,
          canSign: false,
          canAddAddendum: false,
          canMarkError: false,
          rectificationOnly: true,
        },
      }),
    );
    open(routes);

    expect(
      await screen.findByText('La organización está en modo solo lectura'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Firmar nota' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Motivo de la consulta/)).not.toBeInTheDocument();
    expect(screen.getByText('Control')).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no violations while editing', async () => {
    const { routes } = server(draftNote({ content: { reasonForConsultation: 'Control' } }));
    const view = open(routes);
    await screen.findByLabelText(/Motivo de la consulta/);

    expect(await a11yViolations(view.container)).toEqual([]);
  });
});
