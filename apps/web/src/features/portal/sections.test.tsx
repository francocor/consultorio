import type {
  PortalAppointmentDto,
  PortalConsentDetailDto,
  PortalConsentDto,
  PortalDocumentDto,
  PortalInvoiceDto,
  PortalPrescriptionDto,
} from '@consultorio/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../shared/test/render.js';

import { CHILD_LINK, meOf, SELF_LINK, signedInRoutes } from './portal-fixtures.js';

/**
 * The sections of the portal (S5.10, task 5.40): appointments, documents, invoices, prescriptions and
 * consents. Each one has its loading, empty, failed and filled states, and what the patient can do.
 */
function open(
  path: string,
  extra: Record<string, FetchHandler | Response>,
  me = meOf([SELF_LINK], SELF_LINK.id),
) {
  return renderApp({
    me: null,
    path,
    boot: bootFor('Centro Médico Aillu'),
    routes: signedInRoutes(me, extra),
  });
}

const APPOINTMENT: PortalAppointmentDto = {
  id: '0190a000-0000-7000-8000-0000000000c1',
  startsAt: '2031-06-10T13:00:00.000Z',
  endsAt: '2031-06-10T13:30:00.000Z',
  timeZone: 'America/Argentina/Buenos_Aires',
  status: 'scheduled',
  professionalName: 'Dra. Laura Gómez',
  locationName: 'Sede Centro',
  typeName: 'Consulta general',
  mode: 'in_person',
  canConfirm: true,
  canCancel: true,
  cancelDeadline: '2031-06-09T13:00:00.000Z',
  joinUrl: null,
  joinPending: false,
};

const appointment = (overrides: Partial<PortalAppointmentDto> = {}): PortalAppointmentDto => ({
  ...APPOINTMENT,
  ...overrides,
});

describe('the appointments of the patient', () => {
  it('lists the upcoming ones with what can be done, and the past ones apart', async () => {
    const past = appointment({
      id: '0190a000-0000-7000-8000-0000000000c9',
      startsAt: '2031-05-02T13:00:00.000Z',
      status: 'attended',
      canConfirm: false,
      canCancel: false,
      cancelDeadline: null,
    });
    const app = open('/portal', {
      'GET /api/portal/appointments': jsonResponse({ upcoming: [APPOINTMENT], past: [past] }),
    });

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Próximos turnos' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Dra. Laura Gómez', { selector: 'dd' })).toHaveLength(2);
    expect(screen.getAllByText('Consulta general')).toHaveLength(2);
    expect(screen.getByText('Programado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmar asistencia' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar el turno' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Turnos anteriores' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Atendido')).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('shows an empty state when there is nothing yet', async () => {
    open('/portal', { 'GET /api/portal/appointments': jsonResponse({ upcoming: [], past: [] }) });

    expect(await screen.findByText('Todavía no hay turnos')).toBeInTheDocument();
  });

  it('says there is nothing upcoming while still showing the past ones', async () => {
    open('/portal', {
      'GET /api/portal/appointments': jsonResponse({
        upcoming: [],
        past: [appointment({ status: 'attended', canConfirm: false, canCancel: false })],
      }),
    });

    expect(await screen.findByText('No tiene turnos próximos.')).toBeInTheDocument();
    expect(screen.getByText('Atendido')).toBeInTheDocument();
  });

  it('confirms the attendance and shows the new state', async () => {
    const user = userEvent.setup();
    let confirmed = false;
    const app = open('/portal', {
      'GET /api/portal/appointments': () =>
        jsonResponse({
          upcoming: [
            confirmed ? appointment({ status: 'confirmed', canConfirm: false }) : APPOINTMENT,
          ],
          past: [],
        }),
      [`POST /api/portal/appointments/${APPOINTMENT.id}/confirm`]: () => {
        confirmed = true;
        return jsonResponse({
          appointment: appointment({ status: 'confirmed', canConfirm: false }),
        });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Confirmar asistencia' }));

    expect(await screen.findByText('Confirmado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar asistencia' })).not.toBeInTheDocument();
    expect(app.requests).toContain(`POST /api/portal/appointments/${APPOINTMENT.id}/confirm`);
  });

  it('asks before cancelling, and does nothing when the person keeps the appointment', async () => {
    const user = userEvent.setup();
    const app = open('/portal', {
      'GET /api/portal/appointments': jsonResponse({ upcoming: [APPOINTMENT], past: [] }),
    });

    await user.click(await screen.findByRole('button', { name: 'Cancelar el turno' }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Cancelar el turno?' });
    expect(dialog).toHaveTextContent('El horario queda libre para otra persona.');
    await user.click(within(dialog).getByRole('button', { name: 'No, mantener el turno' }));

    expect(
      app.requests.filter((request) => request.startsWith('POST /api/portal/appointments')),
    ).toEqual([]);
  });

  it('cancels once the person confirms the question', async () => {
    const user = userEvent.setup();
    let cancelled = false;
    const app = open('/portal', {
      'GET /api/portal/appointments': () =>
        jsonResponse({
          upcoming: cancelled ? [] : [APPOINTMENT],
          past: cancelled
            ? [appointment({ status: 'cancelled', canConfirm: false, canCancel: false })]
            : [],
        }),
      [`POST /api/portal/appointments/${APPOINTMENT.id}/cancel`]: () => {
        cancelled = true;
        return jsonResponse({
          appointment: appointment({ status: 'cancelled', canConfirm: false, canCancel: false }),
        });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Cancelar el turno' }));
    await user.click(await screen.findByRole('button', { name: 'Sí, cancelar el turno' }));

    expect(await screen.findByText('Cancelado')).toBeInTheDocument();
    expect(app.requests).toContain(`POST /api/portal/appointments/${APPOINTMENT.id}/cancel`);
  });

  it('explains the refusal in plain words when the deadline passed meanwhile', async () => {
    const user = userEvent.setup();
    open('/portal', {
      'GET /api/portal/appointments': jsonResponse({ upcoming: [APPOINTMENT], past: [] }),
      [`POST /api/portal/appointments/${APPOINTMENT.id}/cancel`]: problemResponse(
        409,
        'portal_cancel_deadline_passed',
      ),
    });

    await user.click(await screen.findByRole('button', { name: 'Cancelar el turno' }));
    await user.click(await screen.findByRole('button', { name: 'Sí, cancelar el turno' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ya no se puede cancelar desde el portal porque falta muy poco para el turno.',
    );
  });

  it('shows that the deadline passed instead of a cancel button', async () => {
    open('/portal', {
      'GET /api/portal/appointments': jsonResponse({
        upcoming: [appointment({ canCancel: false })],
        past: [],
      }),
    });

    expect(
      await screen.findByText(/Ya pasó el plazo para cancelar desde el portal/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar el turno' })).not.toBeInTheDocument();
  });

  it('offers the address of a video appointment, or says it will appear', async () => {
    open('/portal', {
      'GET /api/portal/appointments': jsonResponse({
        upcoming: [
          appointment({ mode: 'virtual', joinUrl: 'https://meet.example.test/room-1' }),
          appointment({
            id: '0190a000-0000-7000-8000-0000000000c2',
            mode: 'virtual',
            joinPending: true,
          }),
        ],
        past: [],
      }),
    });

    const join = await screen.findByRole('link', { name: 'Unirme a la videollamada' });
    expect(join).toHaveAttribute('href', 'https://meet.example.test/room-1');
    expect(join).toHaveAttribute('rel', 'noreferrer noopener');
    expect(
      screen.getByText('El enlace de la videollamada aparecerá aquí cuando esté listo.'),
    ).toBeInTheDocument();
  });

  it('keeps data of one record away from another when the person switches', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open(
      '/portal',
      {
        'POST /api/portal/subject': jsonResponse(meOf([SELF_LINK, CHILD_LINK], CHILD_LINK.id)),
        'GET /api/portal/appointments': () => {
          calls.push('appointments');
          return jsonResponse({
            upcoming: calls.length === 1 ? [APPOINTMENT] : [],
            past: [],
          });
        },
      },
      meOf([SELF_LINK, CHILD_LINK], SELF_LINK.id),
    );
    expect(await screen.findByText('Consulta general')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cambiar de persona' }));
    await user.click(await screen.findByRole('button', { name: /Beto Pérez/ }));

    expect(await screen.findByText('Todavía no hay turnos')).toBeInTheDocument();
    expect(screen.queryByText('Consulta general')).not.toBeInTheDocument();
  });
});

const DOCUMENT: PortalDocumentDto = {
  id: '0190a000-0000-7000-8000-0000000000d1',
  name: 'Análisis de sangre.pdf',
  category: 'lab_result',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  sharedAt: '2031-05-20T15:00:00.000Z',
};

describe('the documents shared with the patient', () => {
  let downloaded: string[];
  beforeEach(() => {
    downloaded = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded.push(this.download);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an empty state that says the consultorio shares them', async () => {
    open('/portal/documentos', { 'GET /api/portal/documents': jsonResponse({ documents: [] }) });

    expect(await screen.findByText('Todavía no hay documentos')).toBeInTheDocument();
    expect(
      screen.getByText(/Cuando el consultorio comparta un documento con usted/),
    ).toBeInTheDocument();
  });

  it('lists what was shared with its category, date and size', async () => {
    const app = open('/portal/documentos', {
      'GET /api/portal/documents': jsonResponse({ documents: [DOCUMENT] }),
    });

    expect(await screen.findByText('Análisis de sangre.pdf')).toBeInTheDocument();
    expect(screen.getByText(/Resultado de laboratorio/)).toBeInTheDocument();
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Descargar Análisis de sangre.pdf' }),
    ).toBeInTheDocument();
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('downloads through a link for the session and hands the file to the browser', async () => {
    const user = userEvent.setup();
    const app = open('/portal/documentos', {
      'GET /api/portal/documents': jsonResponse({ documents: [DOCUMENT] }),
      [`POST /api/portal/documents/${DOCUMENT.id}/download-link`]: jsonResponse({
        url: '/portal/files/TOKEN1',
        expiresAt: '2031-05-20T15:05:00.000Z',
      }),
      'GET /api/portal/files/TOKEN1': () =>
        new Response('%PDF-1.4', {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="resultado.pdf"',
          },
        }),
    });

    await user.click(
      await screen.findByRole('button', { name: 'Descargar Análisis de sangre.pdf' }),
    );

    await vi.waitFor(() => {
      expect(downloaded).toEqual(['resultado.pdf']);
    });
    // The link is asked for first, then followed once; its address never appears on the screen.
    const order = app.requests.filter(
      (request) => request.includes('download-link') || request.includes('/files/'),
    );
    expect(order).toEqual([
      `POST /api/portal/documents/${DOCUMENT.id}/download-link`,
      'GET /api/portal/files/TOKEN1',
    ]);
    expect(screen.queryByText(/TOKEN1/)).not.toBeInTheDocument();
  });

  it('says so next to the button when the file cannot be downloaded', async () => {
    const user = userEvent.setup();
    open('/portal/documentos', {
      'GET /api/portal/documents': jsonResponse({ documents: [DOCUMENT] }),
      [`POST /api/portal/documents/${DOCUMENT.id}/download-link`]: problemResponse(
        404,
        'not_found',
      ),
    });

    await user.click(
      await screen.findByRole('button', { name: 'Descargar Análisis de sangre.pdf' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Este documento no está disponible para descargar.',
    );
    expect(downloaded).toEqual([]);
  });

  it('shows an error with a retry when the list fails', async () => {
    const user = userEvent.setup();
    let fails = true;
    open('/portal/documentos', {
      'GET /api/portal/documents': () =>
        fails ? problemResponse(500, 'internal_error') : jsonResponse({ documents: [DOCUMENT] }),
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fails = false;

    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('Análisis de sangre.pdf')).toBeInTheDocument();
  });
});

const INVOICE: PortalInvoiceDto = {
  id: '0190a000-0000-7000-8000-0000000000e1',
  kind: 'invoice',
  type: 'C',
  pointOfSale: 3,
  number: 41,
  issueDate: '2031-05-15',
  totalCents: 1_250_000,
  hasPdf: true,
  testDocument: false,
};

describe('the invoices of the patient', () => {
  it('shows an empty state', async () => {
    open('/portal/facturas', { 'GET /api/portal/invoices': jsonResponse({ invoices: [] }) });

    expect(await screen.findByText('Todavía no hay facturas')).toBeInTheDocument();
  });

  it('lists the voucher with its number and total, a download, and the test mark when it applies', async () => {
    const app = open('/portal/facturas', {
      'GET /api/portal/invoices': jsonResponse({
        invoices: [
          INVOICE,
          {
            ...INVOICE,
            id: '0190a000-0000-7000-8000-0000000000e2',
            kind: 'credit_note',
            number: 2,
            hasPdf: false,
            testDocument: true,
          },
        ],
      }),
    });

    expect(await screen.findByText('0003-00000041')).toBeInTheDocument();
    expect(screen.getAllByText(/12\.500,00/)).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Descargar Factura 0003-00000041' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Nota de crédito')).toBeInTheDocument();
    expect(screen.getByText('Documento de prueba, sin validez fiscal')).toBeInTheDocument();
    expect(screen.getByText('El comprobante se está preparando.')).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

const PRESCRIPTION: PortalPrescriptionDto = {
  id: '0190a000-0000-7000-8000-0000000000f1',
  issuedAt: '2031-05-18T14:00:00.000Z',
  status: 'issued',
  prescriberName: 'Dra. Laura Gómez',
  hasDocument: true,
};

describe('the prescriptions of the patient', () => {
  it('shows the empty state while no module serves them', async () => {
    open('/portal/recetas', {
      'GET /api/portal/prescriptions': jsonResponse({ available: false, prescriptions: [] }),
    });

    expect(await screen.findByText('Todavía no hay recetas')).toBeInTheDocument();
  });

  it('lists each prescription with where it stands, never its medications', async () => {
    const app = open('/portal/recetas', {
      'GET /api/portal/prescriptions': jsonResponse({
        available: true,
        prescriptions: [
          PRESCRIPTION,
          {
            ...PRESCRIPTION,
            id: '0190a000-0000-7000-8000-0000000000f2',
            issuedAt: null,
            status: 'pending_submission',
            prescriberName: null,
            hasDocument: false,
          },
        ],
      }),
    });

    expect(await screen.findByText('Vigente')).toBeInTheDocument();
    expect(screen.getByText('Profesional: Dra. Laura Gómez')).toBeInTheDocument();
    expect(screen.getByText('Receta sin emitir')).toBeInTheDocument();
    expect(screen.getByText('En proceso')).toBeInTheDocument();
    expect(screen.getByText('Profesional no indicado')).toBeInTheDocument();
    // Only the prescription with a document can be downloaded.
    expect(screen.getAllByRole('button', { name: /Descargar la receta/ })).toHaveLength(1);
    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

const CONSENT: PortalConsentDto = {
  id: '0190a000-0000-7000-8000-000000000101',
  title: 'Consentimiento informado de tratamiento',
  status: 'pending',
  requestedAt: '2031-05-19T12:00:00.000Z',
  signedAt: null,
  revokedAt: null,
  expiresAt: '2031-07-01T00:00:00.000Z',
  canSign: true,
  canRevoke: false,
  hasDocument: false,
};

/** The fingerprint of the text on screen: the signature sends it back (JD-S5 R1-B-S4). */
const HASH = 'c'.repeat(64);

const detail = (overrides: Partial<PortalConsentDetailDto> = {}): PortalConsentDetailDto => ({
  ...CONSENT,
  body: 'Acepto el tratamiento propuesto y entiendo sus alcances.',
  contentHash: HASH,
  requiresRepresentative: false,
  ...overrides,
});

/** Leaves the signature as the keyboard does: the pad's typed-name alternative. */
async function typeSignature(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: 'Escribir el nombre' }));
  await user.type(screen.getByLabelText('Nombre completo, como firma'), name);
}

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

/** A canvas jsdom can draw on, answering with a small image. */
function stubCanvas() {
  const context = {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    clearRect: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(IMAGE);
}

describe('the consents of the patient', () => {
  it('shows the empty state while no module serves them', async () => {
    open('/portal/consentimientos', {
      'GET /api/portal/consents': jsonResponse({ available: false, consents: [] }),
    });

    expect(await screen.findByText('No tiene consentimientos')).toBeInTheDocument();
  });

  it('lists the ones to sign and the signed ones, each with a way in', async () => {
    const signed: PortalConsentDto = {
      ...CONSENT,
      id: '0190a000-0000-7000-8000-000000000102',
      title: 'Autorización de imágenes',
      status: 'signed',
      signedAt: '2031-05-21T12:00:00.000Z',
      canSign: false,
      canRevoke: true,
      hasDocument: true,
    };
    const app = open('/portal/consentimientos', {
      'GET /api/portal/consents': jsonResponse({ available: true, consents: [CONSENT, signed] }),
    });

    expect(await screen.findByText('Para firmar')).toBeInTheDocument();
    expect(screen.getByText('Firmado')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Leer y firmar/ })).toHaveAttribute(
      'href',
      `/portal/consentimientos/${CONSENT.id}`,
    );
    expect(screen.getByRole('link', { name: /Ver/ })).toHaveAttribute(
      'href',
      `/portal/consentimientos/${signed.id}`,
    );
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('shows the full text and requires the explicit acceptance before signing', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const app = open(`/portal/consentimientos/${CONSENT.id}`, {
      [`GET /api/portal/consents/${CONSENT.id}`]: jsonResponse(detail()),
      [`POST /api/portal/consents/${CONSENT.id}/sign`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({
          consent: {
            ...CONSENT,
            status: 'signed',
            canSign: false,
            signedAt: '2031-05-22T12:00:00.000Z',
          },
        });
      },
      'GET /api/portal/consents': jsonResponse({ available: true, consents: [] }),
    });

    expect(
      await screen.findByRole('article', { name: 'Texto del consentimiento' }),
    ).toHaveTextContent('Acepto el tratamiento propuesto y entiendo sus alcances.');
    expect(screen.getByText(/Puede firmarlo hasta el/)).toBeInTheDocument();
    expect(await a11yViolations(app.container)).toEqual([]);

    // Without the box: refused on the screen, no request.
    await user.type(screen.getByLabelText('Escriba su nombre completo'), 'Ana Pérez');
    await typeSignature(user, 'Ana Pérez');
    await user.click(screen.getByRole('button', { name: 'Firmar el documento' }));
    expect(await screen.findByText('Marque la casilla para poder firmar.')).toBeInTheDocument();
    expect(bodies).toEqual([]);

    await user.click(
      screen.getByRole('checkbox', { name: /Leí el documento completo y estoy de acuerdo/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Firmar el documento' }));

    await vi.waitFor(() => {
      expect(bodies).toEqual([
        {
          accepted: true,
          contentHash: HASH,
          signerName: 'Ana Pérez',
          signature: { kind: 'typed', value: 'Ana Pérez' },
        },
      ]);
    });
  });

  it('asks for a signature, drawn or typed, before signing', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(`/portal/consentimientos/${CONSENT.id}`, {
      [`GET /api/portal/consents/${CONSENT.id}`]: jsonResponse(detail()),
      [`POST /api/portal/consents/${CONSENT.id}/sign`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return problemResponse(500, 'internal_error');
      },
    });

    await user.type(await screen.findByLabelText('Escriba su nombre completo'), 'Ana Pérez');
    await user.click(screen.getByRole('checkbox', { name: /Leí el documento completo/ }));
    await user.click(screen.getByRole('button', { name: 'Firmar el documento' }));

    expect(
      await screen.findByText('Dibuje su firma o escriba su nombre en el recuadro de la firma.'),
    ).toBeInTheDocument();
    expect(bodies).toEqual([]);
  });

  it('signs with the drawing the person made on the pad', async () => {
    stubCanvas();
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(`/portal/consentimientos/${CONSENT.id}`, {
      [`GET /api/portal/consents/${CONSENT.id}`]: jsonResponse(detail()),
      [`POST /api/portal/consents/${CONSENT.id}/sign`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({ consent: { ...CONSENT, status: 'signed', canSign: false } });
      },
      'GET /api/portal/consents': jsonResponse({ available: true, consents: [] }),
    });

    await user.type(await screen.findByLabelText('Escriba su nombre completo'), 'Ana Pérez');
    const canvas = screen.getByRole('img', { name: /Espacio para dibujar la firma/ });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    await user.click(screen.getByRole('checkbox', { name: /Leí el documento completo/ }));
    await user.click(screen.getByRole('button', { name: 'Firmar el documento' }));

    await vi.waitFor(() => {
      expect(bodies).toEqual([
        {
          accepted: true,
          contentHash: HASH,
          signerName: 'Ana Pérez',
          signature: { kind: 'drawn', value: IMAGE },
        },
      ]);
    });
  });

  it('asks for a name before signing', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(`/portal/consentimientos/${CONSENT.id}`, {
      [`GET /api/portal/consents/${CONSENT.id}`]: jsonResponse(detail()),
      [`POST /api/portal/consents/${CONSENT.id}/sign`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return problemResponse(500, 'internal_error');
      },
    });

    await user.click(await screen.findByRole('checkbox', { name: /Leí el documento completo/ }));
    await user.click(screen.getByRole('button', { name: 'Firmar el documento' }));

    expect(await screen.findByText('Escriba su nombre completo para firmar.')).toBeInTheDocument();
    expect(bodies).toEqual([]);
  });

  it('asks for the data of the representative when the subject is a minor, and sends them', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(
      `/portal/consentimientos/${CONSENT.id}`,
      {
        [`GET /api/portal/consents/${CONSENT.id}`]: jsonResponse(
          detail({ requiresRepresentative: true }),
        ),
        [`POST /api/portal/consents/${CONSENT.id}/sign`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ consent: { ...CONSENT, status: 'signed', canSign: false } });
        },
        'GET /api/portal/consents': jsonResponse({ available: true, consents: [] }),
      },
      meOf([CHILD_LINK], CHILD_LINK.id),
    );

    await user.type(await screen.findByLabelText('Nombre completo de quien firma'), 'María Pérez');
    await typeSignature(user, 'María Pérez');
    await user.click(screen.getByRole('checkbox', { name: /Leí el documento completo/ }));
    await user.click(screen.getByRole('button', { name: 'Firmar el documento' }));
    expect(
      await screen.findByText('Complete el nombre y el DNI de quien firma.'),
    ).toBeInTheDocument();
    expect(bodies).toEqual([]);

    await user.type(screen.getByLabelText('DNI de quien firma'), '20111222');
    await user.click(screen.getByRole('button', { name: 'Firmar el documento' }));

    await vi.waitFor(() => {
      expect(bodies).toEqual([
        {
          accepted: true,
          contentHash: HASH,
          signerName: 'María Pérez',
          signature: { kind: 'typed', value: 'María Pérez' },
          representative: { fullName: 'María Pérez', nationalId: '20111222', relation: 'mother' },
        },
      ]);
    });
  });

  it('revokes a signed consent with an optional reason, after asking', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(`/portal/consentimientos/${CONSENT.id}`, {
      [`GET /api/portal/consents/${CONSENT.id}`]: jsonResponse(
        detail({
          status: 'signed',
          canSign: false,
          canRevoke: true,
          signedAt: '2031-05-21T12:00:00.000Z',
          hasDocument: true,
        }),
      ),
      [`POST /api/portal/consents/${CONSENT.id}/revoke`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({ consent: { ...CONSENT, status: 'revoked', canSign: false } });
      },
      'GET /api/portal/consents': jsonResponse({ available: true, consents: [] }),
    });

    expect(
      await screen.findByRole('button', {
        name: 'Descargar el consentimiento firmado: Consentimiento informado de tratamiento',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Firmar el documento' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revocar mi consentimiento' }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Revocar el consentimiento?' });
    await user.type(within(dialog).getByLabelText('Motivo (opcional)'), 'Cambié de opinión');
    await user.click(within(dialog).getByRole('button', { name: 'Sí, revocarlo' }));

    await vi.waitFor(() => {
      expect(bodies).toEqual([{ reason: 'Cambié de opinión' }]);
    });
  });

  it('shows no text for a consent that is signed, only what can be done with it', async () => {
    open(`/portal/consentimientos/${CONSENT.id}`, {
      [`GET /api/portal/consents/${CONSENT.id}`]: jsonResponse(
        detail({ status: 'signed', canSign: false, canRevoke: true, hasDocument: true, body: '' }),
      ),
    });

    expect(
      await screen.findByRole('button', { name: /Descargar el consentimiento firmado/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: 'Texto del consentimiento' }),
    ).not.toBeInTheDocument();
  });

  it('sends no reason when the person writes none', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(`/portal/consentimientos/${CONSENT.id}`, {
      [`GET /api/portal/consents/${CONSENT.id}`]: jsonResponse(
        detail({ status: 'signed', canSign: false, canRevoke: true }),
      ),
      [`POST /api/portal/consents/${CONSENT.id}/revoke`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({ consent: { ...CONSENT, status: 'revoked', canSign: false } });
      },
      'GET /api/portal/consents': jsonResponse({ available: true, consents: [] }),
    });

    await user.click(await screen.findByRole('button', { name: 'Revocar mi consentimiento' }));
    await user.click(await screen.findByRole('button', { name: 'Sí, revocarlo' }));

    await vi.waitFor(() => {
      expect(bodies).toEqual([{}]);
    });
  });
});
