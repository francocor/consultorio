import type { ArchiveOverviewDto, ArchiveReleaseRequestDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../shared/test/a11y.js';
import { renderApp, type RenderedApp } from '../../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../../shared/test/render.js';

const OPERATOR = {
  id: '0190a000-0000-7000-8000-0000000000c1',
  email: 'operador@demo.invalid',
  displayName: 'Operador de la plataforma',
};
const ORG = '0190a000-0000-7000-8000-0000000000d2';

const TENANTS = [
  {
    id: '0190a000-0000-7000-8000-0000000000d1',
    slug: 'aillu',
    name: 'Centro Médico Aillu',
    status: 'active',
    isDemo: false,
    country: 'AR',
    createdAt: '2026-10-01T12:00:00.000Z',
  },
  {
    id: ORG,
    slug: 'clinica-sur',
    name: 'Clínica del Sur',
    status: 'cancelled',
    isDemo: false,
    country: 'AR',
    createdAt: '2026-10-01T12:00:00.000Z',
  },
];

const ARCHIVE: ArchiveOverviewDto = {
  organization: ORG,
  status: 'written',
  archivedAt: '2031-06-01T12:00:00.000Z',
  objects: 42,
  bytes: 5_242_880,
  retainUntil: '2051-06-01T12:00:00.000Z',
  verifiedAt: '2031-06-08T12:00:00.000Z',
  verifyStatus: 'ok',
  verifyProblems: 0,
};

const request = (overrides: Partial<ArchiveReleaseRequestDto> = {}): ArchiveReleaseRequestDto => ({
  id: '0190a000-0000-7000-8000-0000000000e1',
  organization: ORG,
  status: 'requested',
  requesterKind: 'patient',
  requesterName: 'Ana Gómez',
  requesterEmail: 'ana@example.com',
  scope: 'DNI 20111222',
  reason: 'Necesito mi historia clínica',
  createdAt: '2031-06-10T12:00:00.000Z',
  identityVerifiedAt: null,
  approvedAt: null,
  expiresAt: null,
  releasedAt: null,
  linkExpiresAt: null,
  downloadedAt: null,
  rejectedReason: null,
  failureCode: null,
  canVerifyIdentity: true,
  canApprove: false,
  canReject: true,
  ...overrides,
});

let current: RenderedApp | undefined;
let bodies: Record<string, unknown[]> = {};

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(
  requests: ArchiveReleaseRequestDto[],
  routes: Record<string, FetchHandler> = {},
  archives: ArchiveOverviewDto[] = [ARCHIVE],
) {
  bodies = {};
  current = renderApp({
    platform: true,
    me: null,
    path: '/',
    routes: {
      'GET /api/operator/me': () => jsonResponse(OPERATOR),
      'GET /api/operator/tenants': () => jsonResponse({ tenants: TENANTS }),
      'GET /api/operator/dev/providers': () => problemResponse(404, 'not_found'),
      'GET /api/operator/archives': () => jsonResponse({ archives }),
      'GET /api/operator/archive-releases': () => jsonResponse({ requests }),
      ...routes,
    },
  });
}

/** A route that keeps the bodies it receives under `key` and answers with a request. */
function recorded(
  key: string,
  answer: () => Response = () => jsonResponse(request()),
): FetchHandler {
  return (_url, init) => {
    (bodies[key] ??= []).push(jsonBody(init));
    return answer();
  };
}

async function openTab() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Archivo' }));
  await screen.findByRole('heading', { name: 'Solicitudes de liberación' });
  return user;
}

describe('the archive tab: states and requests', () => {
  it('lists each archive with its counts, dates and last check, and never a record', async () => {
    open([]);
    await openTab();

    const row = (await screen.findByRole('cell', { name: 'Clínica del Sur' })).closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText('Escrito')).toBeInTheDocument();
    expect(cells.getByText('42')).toBeInTheDocument();
    expect(cells.getByText('5,0 MB')).toBeInTheDocument();
    expect(cells.getByText('Íntegro')).toBeInTheDocument();
  });

  it('says when there is no archive and no request yet', async () => {
    open([], {}, []);
    await openTab();

    expect(await screen.findByText('Todavía no hay archivos')).toBeInTheDocument();
    expect(await screen.findByText('No hay solicitudes')).toBeInTheDocument();
  });

  it('shows who asks, what finds them and where the request stands', async () => {
    open([request()]);
    await openTab();

    expect(await screen.findByText('Ana Gómez')).toBeInTheDocument();
    expect(screen.getByText('ana@example.com')).toBeInTheDocument();
    expect(screen.getByText('DNI 20111222')).toBeInTheDocument();
    expect(screen.getByText('Solicitada')).toBeInTheDocument();
  });

  it('passes the accessibility check', async () => {
    open([request()]);
    await openTab();
    await screen.findByText('Ana Gómez');

    expect(await a11yViolations(document.body)).toEqual([]);
  });
});

describe('verifying the identity', () => {
  const PATH = `POST /api/operator/archive-releases/${request().id}/verify-identity`;

  it('does not continue until the four checks are ticked, then sends them', async () => {
    open([request()], { [PATH]: recorded('verify') });
    const user = await openTab();

    await user.click(
      await screen.findByRole('button', { name: 'Verificar la identidad de Ana Gómez' }),
    );
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Confirmar verificación' });
    expect(confirm).toBeDisabled();

    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    for (const box of boxes.slice(0, 3)) await user.click(box);
    expect(confirm).toBeDisabled();

    await user.click(boxes[3] as HTMLElement);
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => {
      expect(bodies['verify']).toEqual([
        {
          documentChecked: true,
          photoMatches: true,
          contactConfirmed: true,
          entitlementChecked: true,
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('passes the accessibility check with the dialog open', async () => {
    open([request()]);
    const user = await openTab();

    await user.click(
      await screen.findByRole('button', { name: 'Verificar la identidad de Ana Gómez' }),
    );

    expect(await a11yViolations(await screen.findByRole('dialog'))).toEqual([]);
  });
});

describe('approving', () => {
  const verified = (overrides: Partial<ArchiveReleaseRequestDto> = {}) =>
    request({
      status: 'identity_verified',
      identityVerifiedAt: '2031-06-10T13:00:00.000Z',
      canVerifyIdentity: false,
      ...overrides,
    });
  const PATH = `POST /api/operator/archive-releases/${request().id}/approve`;

  it('offers the approval to a different operator and sends it', async () => {
    open([verified({ canApprove: true })], { [PATH]: recorded('approve') });
    const user = await openTab();

    await user.click(
      await screen.findByRole('button', { name: 'Aprobar la solicitud de Ana Gómez' }),
    );

    await waitFor(() => {
      expect(bodies['approve']).toHaveLength(1);
    });
  });

  it('does not offer it to the operator who verified the identity', async () => {
    open([verified({ canApprove: false })]);
    await openTab();

    expect(await screen.findByText('La aprueba otra persona del equipo.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Aprobar la solicitud/ })).not.toBeInTheDocument();
  });

  it('says so when the server refuses the approval', async () => {
    open([verified({ canApprove: true })], {
      [PATH]: () => problemResponse(409, 'archive_release_same_operator'),
    });
    const user = await openTab();

    await user.click(
      await screen.findByRole('button', { name: 'Aprobar la solicitud de Ana Gómez' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo aprobar la solicitud');
  });
});

describe('rejecting', () => {
  const PATH = `POST /api/operator/archive-releases/${request().id}/reject`;

  it('asks for a reason of some length before it closes the request', async () => {
    open([request()], { [PATH]: recorded('reject') });
    const user = await openTab();

    await user.click(
      await screen.findByRole('button', { name: 'Rechazar la solicitud de Ana Gómez' }),
    );
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Rechazar solicitud' });
    expect(submit).toBeDisabled();

    const reason = within(dialog).getByLabelText('Motivo del rechazo');
    await user.type(reason, 'no');
    expect(submit).toBeDisabled();
    await user.type(reason, ' coincide el documento');
    await user.click(submit);

    await waitFor(() => {
      expect(bodies['reject']).toEqual([{ reason: 'no coincide el documento' }]);
    });
  });
});

describe('recording a request', () => {
  const PATH = 'POST /api/operator/archive-releases';

  it('records a patient by document, for a cancelled organization only', async () => {
    open([], { [PATH]: recorded('record') });
    const user = await openTab();

    await user.click(await screen.findByRole('button', { name: 'Nueva solicitud' }));
    const dialog = await screen.findByRole('dialog');
    const organization = within(dialog).getByLabelText('Organización cancelada');
    expect(
      within(organization)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Elija una organización', 'Clínica del Sur']);

    await user.selectOptions(organization, ORG);
    await user.type(within(dialog).getByLabelText('Nombre completo'), 'Ana Gómez');
    await user.type(within(dialog).getByLabelText('Correo electrónico'), 'ana@example.com');
    await user.type(within(dialog).getByLabelText('Número de documento'), '20111222');
    await user.type(
      within(dialog).getByLabelText('Motivo de la solicitud'),
      'Necesito mi historia',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Registrar solicitud' }));

    await waitFor(() => {
      expect(bodies['record']).toEqual([
        {
          organization: ORG,
          requesterKind: 'patient',
          requesterName: 'Ana Gómez',
          requesterEmail: 'ana@example.com',
          reason: 'Necesito mi historia',
          documentType: 'dni',
          document: '20111222',
        },
      ]);
    });
  });

  it('asks a professional for the registration instead of the document', async () => {
    open([], { [PATH]: recorded('record') });
    const user = await openTab();

    await user.click(await screen.findByRole('button', { name: 'Nueva solicitud' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByLabelText('Quién pide los registros'),
      'professional',
    );

    expect(within(dialog).queryByLabelText('Número de documento')).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Organización cancelada'), ORG);
    await user.type(within(dialog).getByLabelText('Nombre completo'), 'Dra. Ana Pérez');
    await user.type(within(dialog).getByLabelText('Correo electrónico'), 'ana@example.com');
    await user.type(within(dialog).getByLabelText('Jurisdicción'), 'AR-B');
    await user.type(within(dialog).getByLabelText('Matrícula'), '123456');
    await user.type(within(dialog).getByLabelText('Motivo de la solicitud'), 'Para mis pacientes');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar solicitud' }));

    await waitFor(() => {
      expect(bodies['record']).toEqual([
        {
          organization: ORG,
          requesterKind: 'professional',
          requesterName: 'Dra. Ana Pérez',
          requesterEmail: 'ana@example.com',
          reason: 'Para mis pacientes',
          matriculaJurisdiction: 'AR-B',
          matricula: '123456',
        },
      ]);
    });
  });

  it('passes the accessibility check with the dialog open', async () => {
    open([]);
    const user = await openTab();

    await user.click(await screen.findByRole('button', { name: 'Nueva solicitud' }));

    expect(await a11yViolations(await screen.findByRole('dialog'))).toEqual([]);
  });
});
