import type { ConsentTemplateDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

import { ConsentPage } from './ConsentPage.js';
import { BODY, detail, TEMPLATE, template } from './test-fixtures.js';
import { renderHosted } from './test-host.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

const TYPE = '0190a000-0000-7000-8000-0000000000a1';
const DRAFT = '0190a000-0000-7000-8000-0000000000e2';
const RETIRED = '0190a000-0000-7000-8000-0000000000e3';

const STARTERS = {
  starters: [
    {
      key: 'odontology_extraction',
      specialty: 'odontology',
      title: 'Consentimiento informado para extracción dental',
      body: 'Texto del ejemplo de extracción dental.',
    },
    {
      key: 'general_care',
      specialty: 'general',
      title: 'Consentimiento informado para la atención médica',
      body: 'Texto del ejemplo de atención médica.',
    },
  ],
};

function open(
  templates: ConsentTemplateDto[],
  extra: Record<string, Handler | Response> = {},
  options: { role?: 'owner' | 'admin' | 'professional'; readOnly?: boolean } = {},
) {
  const app = renderHosted(<ConsentPage />, {
    me: meFor([options.role ?? 'admin'], options.readOnly ? { tenantStatus: 'read_only' } : {}),
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/consent/templates': () => jsonResponse({ templates }),
      'GET /api/consent/appointment-types': () =>
        jsonResponse({
          requirements: [
            { appointmentTypeId: TYPE, appointmentTypeName: 'Extracción', templateId: null },
          ],
        }),
      'GET /api/consent/starters': () => jsonResponse(STARTERS),
      ...extra,
    },
  });
  missing = app.missingKeys;
  return app;
}

/** The cards of the templates, in the order the server sent them (not the other lists of the page). */
async function cards(): Promise<HTMLElement[]> {
  const list = await screen.findByRole('list', { name: 'Plantillas de consentimiento' });
  return within(list).getAllByRole('listitem');
}

const all = [
  template(),
  template({
    id: DRAFT,
    title: 'Borrador de ortodoncia',
    status: 'draft',
    latestVersionNumber: null,
    versionCount: 0,
    specialty: null,
  }),
  template({
    id: RETIRED,
    title: 'Plantilla vieja',
    status: 'retired',
    retiredAt: '2031-02-20T12:00:00.000Z',
    versionCount: 1,
    latestVersionNumber: 1,
  }),
];

describe('the template manager', () => {
  it('lists each template with its state, its latest version and what can be done with it', async () => {
    open(all);

    const list = await screen.findByRole('list', { name: 'Plantillas de consentimiento' });
    const [published, draft, retired] = within(list).getAllByRole('listitem');
    expect(
      within(published as HTMLElement).getByText('Extracción de muela del juicio'),
    ).toBeVisible();
    expect(within(published as HTMLElement).getByText('Publicada')).toBeVisible();
    expect(within(published as HTMLElement).getByText(/Versión 2 · Odontología/)).toBeVisible();
    for (const name of ['Editar', 'Ver versiones', 'Retirar']) {
      expect(within(published as HTMLElement).getByRole('button', { name })).toBeEnabled();
    }
    expect(
      within(published as HTMLElement).queryByRole('button', { name: 'Publicar' }),
    ).not.toBeInTheDocument();

    expect(within(draft as HTMLElement).getByText('Borrador')).toBeVisible();
    expect(within(draft as HTMLElement).getByText(/Sin publicar/)).toBeVisible();
    expect(within(draft as HTMLElement).getByRole('button', { name: 'Publicar' })).toBeEnabled();
    expect(
      within(draft as HTMLElement).queryByRole('button', { name: 'Ver versiones' }),
    ).not.toBeInTheDocument();

    expect(within(retired as HTMLElement).getByText('Retirada')).toBeVisible();
    expect(within(retired as HTMLElement).getByText(/Retirada el/)).toBeVisible();
    expect(
      within(retired as HTMLElement).queryByRole('button', { name: 'Editar' }),
    ).not.toBeInTheDocument();
    expect(
      within(retired as HTMLElement).queryByRole('button', { name: 'Retirar' }),
    ).not.toBeInTheDocument();
    expect(
      within(retired as HTMLElement).getByRole('button', { name: 'Ver versiones' }),
    ).toBeVisible();
  });

  it('starts with an empty state that leads to the first template', async () => {
    open([]);

    expect(await screen.findByText('Todavía no hay plantillas')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Nueva plantilla' }).length).toBeGreaterThan(0);
  });

  it('writes a new template from a starter and saves it as a draft with the starter it came from', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open([], {
      'POST /api/consent/templates': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(
          template({ status: 'draft', latestVersionNumber: null, versionCount: 0 }),
          201,
        );
      },
    });

    await user.click(
      (await screen.findAllByRole('button', { name: 'Nueva plantilla' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Nueva plantilla' });
    await user.selectOptions(await within(dialog).findByLabelText('Empezar desde un ejemplo'), [
      'Consentimiento informado para extracción dental',
    ]);

    expect(within(dialog).getByLabelText('Título')).toHaveValue(
      'Consentimiento informado para extracción dental',
    );
    expect(within(dialog).getByLabelText('Texto del consentimiento')).toHaveValue(
      'Texto del ejemplo de extracción dental.',
    );
    expect(within(dialog).getByLabelText('Especialidad (opcional)')).toHaveValue('odontology');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar borrador' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          title: 'Consentimiento informado para extracción dental',
          body: 'Texto del ejemplo de extracción dental.',
          specialty: 'odontology',
          starterKey: 'odontology_extraction',
        },
      ]);
    });
  });

  it('does not save a template without a title or a text', async () => {
    const user = userEvent.setup();
    open([]);

    await user.click(
      (await screen.findAllByRole('button', { name: 'Nueva plantilla' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Nueva plantilla' });

    expect(within(dialog).getByRole('button', { name: 'Guardar borrador' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Título'), 'Algo');
    expect(within(dialog).getByRole('button', { name: 'Guardar borrador' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Texto del consentimiento'), 'Texto');
    expect(within(dialog).getByRole('button', { name: 'Guardar borrador' })).toBeEnabled();
  });

  it('publishes a draft as version 1', async () => {
    const user = userEvent.setup();
    let published = 0;
    open(all, {
      [`POST /api/consent/templates/${DRAFT}/publish`]: () => {
        published += 1;
        return jsonResponse(
          detail({ id: DRAFT, status: 'published', latestVersionNumber: 1, versionCount: 1 }),
        );
      },
    });

    const draft = (await cards())[1] as HTMLElement;
    await user.click(within(draft).getByRole('button', { name: 'Publicar' }));

    await waitFor(() => {
      expect(published).toBe(1);
    });
    expect(await screen.findByText('La plantilla quedó publicada (versión 1).')).toBeVisible();
  });

  it('says that saving a published template publishes its next version, and sends the change', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(all, {
      [`PATCH /api/consent/templates/${TEMPLATE}`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(detail({ latestVersionNumber: 3, versionCount: 3 }));
      },
    });

    const published = (await cards())[0] as HTMLElement;
    await user.click(within(published).getByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar plantilla' });
    expect(within(dialog).getByText(/Al guardar se publica la versión 3/)).toBeVisible();
    expect(within(dialog).getByLabelText('Texto del consentimiento')).toHaveValue(BODY);
    const text = within(dialog).getByLabelText('Texto del consentimiento');
    await user.clear(text);
    await user.type(text, 'Texto nuevo.');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar y publicar versión 3' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        { title: 'Extracción de muela del juicio', body: 'Texto nuevo.', specialty: 'odontology' },
      ]);
    });
    expect(await screen.findByText('Se publicó la versión 3 de la plantilla.')).toBeVisible();
  });

  it('shows every version, newest first, each one readable', async () => {
    const user = userEvent.setup();
    open(all, { [`GET /api/consent/templates/${TEMPLATE}`]: () => jsonResponse(detail()) });

    const published = (await cards())[0] as HTMLElement;
    await user.click(within(published).getByRole('button', { name: 'Ver versiones' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Versiones de «Extracción de muela del juicio»',
    });
    const versions = await within(dialog).findAllByRole('listitem');
    expect(versions).toHaveLength(2);
    expect(within(versions[0] as HTMLElement).getByText('Versión 2')).toBeVisible();
    expect(within(versions[0] as HTMLElement).getByText('Vigente')).toBeVisible();
    expect(within(versions[1] as HTMLElement).getByText('Versión 1')).toBeVisible();
    expect(within(versions[1] as HTMLElement).queryByText('Vigente')).not.toBeInTheDocument();
    expect(
      within(dialog).getAllByText(/Autorizo la extracción de la muela del juicio/),
    ).toHaveLength(2);
  });

  it('retires a template after confirming, and says what is kept', async () => {
    const user = userEvent.setup();
    let retired = 0;
    open(all, {
      [`POST /api/consent/templates/${TEMPLATE}/retire`]: () => {
        retired += 1;
        return jsonResponse(detail({ status: 'retired', retiredAt: '2031-03-01T12:00:00.000Z' }));
      },
    });

    const published = (await cards())[0] as HTMLElement;
    await user.click(within(published).getByRole('button', { name: 'Retirar' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/los consentimientos que ya se firmaron se conservan/),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Retirar plantilla' }));

    await waitFor(() => {
      expect(retired).toBe(1);
    });
    expect(await screen.findByText('La plantilla fue retirada.')).toBeVisible();
  });

  it('shows what the server refused', async () => {
    const user = userEvent.setup();
    open(all, {
      [`POST /api/consent/templates/${DRAFT}/publish`]: () =>
        problemResponse(409, 'consent_template_not_draft'),
    });

    const draft = (await cards())[1] as HTMLElement;
    await user.click(within(draft).getByRole('button', { name: 'Publicar' }));

    expect(
      await screen.findByText(/Solo se puede publicar una plantilla que está en borrador/),
    ).toBeVisible();
  });

  it('sets the consent an appointment type requires, and clears it', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(all, {
      [`PUT /api/consent/appointment-types/${TYPE}`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({
          appointmentTypeId: TYPE,
          appointmentTypeName: 'Extracción',
          templateId: TEMPLATE,
        });
      },
    });

    const select = await screen.findByLabelText('Extracción');
    // Only the live templates can be required: not the draft, not the retired one.
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['No exige consentimiento', 'Extracción de muela del juicio']);
    await user.selectOptions(select, ['Extracción de muela del juicio']);

    await waitFor(() => {
      expect(bodies).toEqual([{ templateId: TEMPLATE }]);
    });
  });

  it('blocks writing in an organization that is read-only, and says why', async () => {
    open(all, {}, { readOnly: true });

    const list = await screen.findByRole('list', { name: 'Plantillas de consentimiento' });
    const published = within(list).getAllByRole('listitem')[0] as HTMLElement;
    expect(within(published).getByRole('button', { name: 'Editar' })).toBeDisabled();
    expect(within(published).getByRole('button', { name: 'Retirar' })).toBeDisabled();
    expect(within(published).getByRole('button', { name: 'Ver versiones' })).toBeEnabled();
    expect(screen.getAllByRole('button', { name: 'Nueva plantilla' })[0]).toBeDisabled();
  });

  it('is available to the owner and to a professional as well', async () => {
    open(all, {}, { role: 'professional' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Consentimientos' })).toBeVisible();
  });

  it('has no accessibility violations: the list, the editor and the requirements', async () => {
    const user = userEvent.setup();
    const app = open(all);
    const list = await screen.findByRole('list', { name: 'Plantillas de consentimiento' });
    await screen.findByLabelText('Extracción');

    expect(await a11yViolations(list)).toEqual([]);
    expect(
      await a11yViolations(app.container.querySelector('h1')?.parentElement ?? app.container),
    ).toEqual([]);
    await user.click(screen.getAllByRole('button', { name: 'Nueva plantilla' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Nueva plantilla' });
    expect(await a11yViolations(dialog)).toEqual([]);
  });
});
