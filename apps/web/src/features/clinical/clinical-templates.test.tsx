import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../shared/test/render.js';

import { autosaveConfig } from './components/ClinicalEditor.js';
import { CLINICAL_IDS, draftNote } from './fixtures.js';
import { draftServer } from './test-server.js';

/**
 * The specialty templates inside the editor (clinical-records, psychology, physiotherapy, nutrition
 * and odontology). Each one is rendered through the real router, with a fake server that saves.
 */
let current: RenderedApp | undefined;

beforeAll(() => {
  autosaveConfig.delayMs = 150;
});

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(note: ReturnType<typeof draftNote>, extra: Record<string, () => Response> = {}) {
  const server = draftServer(note);
  current = renderApp({
    me: meFor(['professional']),
    path: `/notes/${note.id}`,
    boot: bootFor('Centro Médico Aillu'),
    routes: { ...server.routes, ...extra },
  });
  return { ...server, view: current };
}

describe('psychology', () => {
  const session = { sessionDate: '2026-05-04', modality: 'in_person' as const };

  it('records the modality and the risk as one-tap choices and saves them', async () => {
    const user = userEvent.setup();
    const { state } = open(draftNote({ templateKind: 'psychology', content: session }));

    await user.click(await screen.findByRole('radio', { name: 'Virtual' }));
    await user.click(screen.getByRole('radio', { name: 'Bajo' }));

    await waitFor(() => {
      expect(state.saves.at(-1)?.content).toEqual({ ...session, modality: 'virtual', risk: 'low' });
    });
    expect(screen.queryByText(/Escriba la nota de seguimiento/)).not.toBeInTheDocument();
  });

  it('asks for the follow-up note when the risk is high, and stops asking once it is written', async () => {
    const user = userEvent.setup();
    open(draftNote({ templateKind: 'psychology', content: { ...session, risk: 'low' } }));

    await user.click(await screen.findByRole('radio', { name: 'Alto' }));
    expect(
      await screen.findByText(/El riesgo es alto\. Escriba la nota de seguimiento/),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Nota de seguimiento/), 'Llamar en 48 horas');

    await waitFor(() => {
      expect(
        screen.queryByText(/Escriba la nota de seguimiento antes de firmar/),
      ).not.toBeInTheDocument();
    });
  });

  it('reminds that psychology is not shared by default', async () => {
    open(draftNote({ templateKind: 'psychology', content: session }));

    expect(await screen.findByText(/no se comparten con otros profesionales/)).toBeInTheDocument();
  });
});

describe('physiotherapy', () => {
  const content = { affectedRegion: 'Rodilla derecha', sessionNumber: 3, totalSessions: 10 };

  it('takes the pain from a scale of eleven buttons and saves it', async () => {
    const user = userEvent.setup();
    const { state } = open(draftNote({ templateKind: 'physiotherapy', content }));

    const scale = await screen.findByRole('radiogroup', { name: /Intensidad del dolor/ });
    expect(within(scale).getAllByRole('radio')).toHaveLength(11);
    await user.click(within(scale).getByRole('radio', { name: '6' }));

    expect(within(scale).getByRole('radio', { name: '6' })).toBeChecked();
    await waitFor(() => {
      expect(state.saves.at(-1)?.content).toEqual({ ...content, painIntensity: 6 });
    });
  });

  it('can start at zero (no pain is a value, not a blank)', async () => {
    const user = userEvent.setup();
    const { state } = open(draftNote({ templateKind: 'physiotherapy', content }));

    await user.click(await screen.findByRole('radio', { name: '0' }));

    await waitFor(() => {
      expect(state.saves.at(-1)?.content).toMatchObject({ painIntensity: 0 });
    });
  });

  it('adds a range of motion row with a unit and saves it', async () => {
    const user = userEvent.setup();
    const { state } = open(draftNote({ templateKind: 'physiotherapy', content }));

    await user.click(await screen.findByRole('button', { name: 'Agregar articulación' }));
    await user.type(screen.getByLabelText(/^Articulación/), 'Rodilla');
    await user.type(screen.getByLabelText(/^Valor/), '95');

    await waitFor(() => {
      expect(state.saves.at(-1)?.content).toMatchObject({
        rangeOfMotion: [{ joint: 'Rodilla', value: 95, unit: 'deg' }],
      });
    });
  });

  it('shows the session within the plan', async () => {
    open(draftNote({ templateKind: 'physiotherapy', content }));

    expect(await screen.findByText('Sesión 3 de 10')).toBeInTheDocument();
  });
});

describe('nutrition', () => {
  it('computes the body mass index from weight and height and does not let it be edited', async () => {
    const user = userEvent.setup();
    const { state } = open(
      draftNote({ templateKind: 'nutrition', content: { weightKg: 70, heightM: 1.75 } }),
    );

    expect(await screen.findByText('22,9')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Índice de masa corporal/)).not.toBeInTheDocument();
    const weight = screen.getByLabelText(/Peso \(kg\)/);
    await user.clear(weight);
    await user.type(weight, '90');

    expect(await screen.findByText('29,4')).toBeInTheDocument();
    await waitFor(() => {
      expect(state.saves.at(-1)?.content).toEqual({ weightKg: 90, heightM: 1.75 });
    });
    expect(JSON.stringify(state.saves)).not.toContain('bmi');
  });

  it('asks to complete the data while there is no BMI', async () => {
    open(draftNote({ templateKind: 'nutrition', content: { weightKg: 70 } }));

    expect(await screen.findByText('Complete el peso y la altura')).toBeInTheDocument();
  });

  it('accepts a decimal comma', async () => {
    const user = userEvent.setup();
    const { state } = open(draftNote({ templateKind: 'nutrition', content: { weightKg: 70 } }));

    await user.type(await screen.findByLabelText(/Altura \(m\)/), '1,75');

    await waitFor(() => {
      expect(state.saves.at(-1)?.content).toEqual({ weightKg: 70, heightM: 1.75 });
    });
  });

  it('asks for a confirmation of an implausible height and sends it once given', async () => {
    const user = userEvent.setup();
    const { state } = open(
      draftNote({ templateKind: 'nutrition', content: { weightKg: 70, heightM: 1.75 } }),
    );
    const height = await screen.findByLabelText(/Altura \(m\)/);

    await user.clear(height);
    await user.type(height, '17,5');
    expect((await screen.findAllByText(/Este valor es poco habitual/)).length).toBeGreaterThan(0);
    expect(state.saves.at(-1)?.content).not.toMatchObject({ heightM: 17.5 });

    await user.click(
      screen.getByRole('checkbox', { name: /Confirmo que los valores son correctos/ }),
    );

    await waitFor(() => {
      expect(state.saves.at(-1)?.content).toEqual({
        weightKg: 70,
        heightM: 17.5,
        confirmImplausible: true,
      });
    });
  });
});

describe('odontology', () => {
  const dentist = (content: Record<string, unknown> = {}) =>
    draftNote({ templateKind: 'odontology', content });
  const chart = `GET /api/patients/${CLINICAL_IDS.patient}/clinical/odontogram`;

  it('records a finding on a tooth surface in the odontogram and saves it with the entry', async () => {
    const user = userEvent.setup();
    const { state } = open(dentist({ reasonForConsultation: 'Dolor en molar' }), {
      [chart]: () => jsonResponse({ teeth: {}, entries: 0 }),
    });

    await user.click(await screen.findByRole('button', { name: 'Pieza 16: sin registro' }));
    const panel = screen.getByRole('region', { name: 'Pieza 16' });
    await user.selectOptions(within(panel).getByLabelText('Estado de la pieza'), 'caries');
    await user.selectOptions(
      within(panel).getByLabelText('Hallazgo, cara oclusal o incisal'),
      'caries',
    );

    await waitFor(() => {
      expect(state.saves.at(-1)?.content).toEqual({
        reasonForConsultation: 'Dolor en molar',
        odontogram: {
          '16': { condition: 'caries', surfaces: { occlusal: { finding: 'caries' } } },
        },
      });
    });
  });

  it('draws the current state from the signed entries behind the chart', async () => {
    open(dentist(), {
      [chart]: () =>
        jsonResponse({
          teeth: {
            '26': {
              condition: 'restoration',
              surfaces: {},
              updatedAt: '2026-05-01T10:00:00.000Z',
              authorProfessionalId: CLINICAL_IDS.author,
            },
          },
          entries: 1,
        }),
    });

    expect(
      await screen.findByRole('button', { name: 'Pieza 26: Restauración (estado actual)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Estado actual según las consultas firmadas')).toBeInTheDocument();
  });

  it('still opens when the current chart cannot be read', async () => {
    open(dentist(), { [chart]: () => problemResponse(403, 'forbidden') });

    expect(
      await screen.findByRole('button', { name: 'Pieza 16: sin registro' }),
    ).toBeInTheDocument();
  });

  it('refuses a tooth that does not exist with the message of the tooth, before sending', async () => {
    const { state } = open(dentist({ odontogram: { '19': { condition: 'caries' } } }), {
      [chart]: () => jsonResponse({ teeth: {}, entries: 0 }),
    });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/Motivo de la consulta/), 'Control');

    await waitFor(() => {
      expect(
        screen.getByText('Hay valores incorrectos: corríjalos para que se guarde.'),
      ).toBeInTheDocument();
    });
    expect(state.saves).toEqual([]);
  });
});

describe('accessibility', () => {
  it.each([
    ['psychology', { sessionDate: '2026-05-04', modality: 'virtual', risk: 'medium' }],
    ['physiotherapy', { painIntensity: 4, affectedRegion: 'Hombro', sessionNumber: 2 }],
    ['nutrition', { weightKg: 70, heightM: 1.75 }],
    ['odontology', { reasonForConsultation: 'Control' }],
  ] as const)('has no violations in the %s editor', async (templateKind, content) => {
    const { view } = open(draftNote({ templateKind, content }), {
      [`GET /api/patients/${CLINICAL_IDS.patient}/clinical/odontogram`]: () =>
        jsonResponse({ teeth: {}, entries: 0 }),
    });
    await screen.findByRole('button', { name: 'Firmar nota' });
    await waitFor(() => {
      expect(screen.queryByText('Guardado')).toBeInTheDocument();
    });

    expect(await a11yViolations(view.container)).toEqual([]);
  });
});
