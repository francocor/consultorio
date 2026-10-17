import type { CreateUploadsRequest, DocumentDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';
import { PATIENT_IDS, patient } from '../patients/fixtures.js';

type Handler = (url: string, init: RequestInit) => Response;
const ID = PATIENT_IDS.valentina;
const DOC = '0190a000-0000-7000-8000-0000000000d1';
const TOKEN = 'A'.repeat(43);
const U1 = '0190a000-0000-7000-8000-0000000000a1';
const U2 = '0190a000-0000-7000-8000-0000000000a2';
const U9 = '0190a000-0000-7000-8000-0000000000a9';
const OLD = '0190a000-0000-7000-8000-0000000000a0';

let current: RenderedApp | undefined;

/** Just enough of XMLHttpRequest to drive the direct upload to storage from a test. */
class FakeXhr {
  static all: FakeXhr[] = [];
  url = '';
  body: FormData | null = null;
  status = 0;
  withCredentials = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload: {
    onprogress:
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = { onprogress: null };
  constructor() {
    FakeXhr.all.push(this);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  finish(status: number) {
    this.status = status;
    this.onload?.();
  }
}

beforeEach(() => {
  FakeXhr.all = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  URL.createObjectURL = vi.fn(() => 'blob:documento');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  // A message without a translation shows a raw key to the person: no screen may leave one.
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
  vi.unstubAllGlobals();
});

function doc(overrides: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: DOC,
    patientId: ID,
    name: 'laboratorio.pdf',
    category: 'lab_result',
    classification: 'clinical',
    status: 'available',
    contentType: 'application/pdf',
    size: 2_000_000,
    uploadedAt: '2026-10-16T15:00:00.000Z',
    uploadedByName: 'Dra. Ana Pérez',
    rejectionReason: null,
    encounterId: null,
    appointmentId: null,
    replacesDocumentId: null,
    versionCount: 1,
    duplicateOf: null,
    hidden: null,
    metadataOnly: false,
    ...overrides,
  };
}

type Role = 'professional' | 'reception' | 'admin';

function open(
  list: DocumentDto[] | Handler,
  routes: Record<string, Handler> = {},
  role: Role = 'professional',
) {
  current = renderApp({
    me: meFor([role]),
    path: `/patients/${ID}`,
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      [`GET /api/patients/${ID}`]: () => jsonResponse(patient()),
      [`GET /api/patients/${ID}/representatives`]: () =>
        jsonResponse({ minor: false, representatives: [] }),
      [`GET /api/patients/${ID}/documents`]:
        typeof list === 'function' ? list : () => jsonResponse({ documents: list }),
      ...routes,
    },
  });
  return current;
}

async function openTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Documentos' }));
}

// The picker filters by `accept`, but a dropped file or an "all files" choice does not: the
// screen must refuse what it is given, so the tests hand it files regardless of `accept`.
const anyFile = () => userEvent.setup({ applyAccept: false });

const pdf = (name: string, size = 1000) =>
  new File([new Uint8Array(size)], name, { type: 'application/pdf' });

describe('the list of documents', () => {
  it('shows each document with its type, size, uploader, state and the actions that apply', async () => {
    const user = userEvent.setup();
    open([
      doc(),
      doc({
        id: '0190a000-0000-7000-8000-0000000000d2',
        name: 'credencial.pdf',
        category: 'coverage_card',
        classification: 'administrative',
        status: 'quarantined',
        contentType: null,
        size: 150_000,
      }),
      doc({
        id: '0190a000-0000-7000-8000-0000000000d3',
        name: 'sospechoso.pdf',
        status: 'rejected',
        rejectionReason: 'infected',
        size: 3000,
      }),
    ]);
    await openTab(user);

    const list = await screen.findByRole('list', { name: 'Documentos del paciente' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);

    const available = items[0];
    expect(within(available as HTMLElement).getByText('laboratorio.pdf')).toBeInTheDocument();
    expect(
      within(available as HTMLElement).getByText(/Resultado de laboratorio · 1,9 MB/),
    ).toBeInTheDocument();
    expect(
      within(available as HTMLElement).getByText(/Subido por Dra\. Ana Pérez el 16\/10\/2026/),
    ).toBeInTheDocument();
    expect(within(available as HTMLElement).getByText('Disponible')).toBeInTheDocument();
    expect(within(available as HTMLElement).getByText('Clínico')).toBeInTheDocument();
    expect(
      within(available as HTMLElement).getByRole('button', { name: 'Descargar laboratorio.pdf' }),
    ).toBeInTheDocument();

    // A file still being scanned says so, and offers no download at all.
    const scanning = items[1] as HTMLElement;
    expect(within(scanning).getByText('Analizando')).toBeInTheDocument();
    expect(within(scanning).getByText(/Se está revisando el archivo/)).toBeInTheDocument();
    expect(within(scanning).queryByRole('button', { name: /Descargar/ })).toBeNull();
    expect(within(scanning).getByText('Administrativo')).toBeInTheDocument();

    // A refused file says why.
    const refused = items[2] as HTMLElement;
    expect(within(refused).getByText('Rechazado')).toBeInTheDocument();
    expect(within(refused).getByText(/software malicioso/)).toBeInTheDocument();
    expect(within(refused).queryByRole('button', { name: /Descargar/ })).toBeNull();
  });

  it('shows reception the name and category of a clinical document, marked as reserved, without any action', async () => {
    const user = userEvent.setup();
    open([doc({ metadataOnly: true })], {}, 'reception');
    await openTab(user);

    const item = await screen.findByRole('listitem');
    expect(within(item).getByText('laboratorio.pdf')).toBeInTheDocument();
    expect(within(item).getByText(/Solo se muestran el nombre y la categoría/)).toBeInTheDocument();
    expect(within(item).queryByRole('button')).toBeNull();
    expect(within(item).queryByText('Disponible')).toBeNull();
  });

  it('says how many versions a document has and opens them, newest first, with the current one marked', async () => {
    const user = userEvent.setup();
    const older = doc({
      id: '0190a000-0000-7000-8000-0000000000d0',
      uploadedAt: '2026-10-01T10:00:00.000Z',
    });
    open([doc({ versionCount: 2, replacesDocumentId: older.id })], {
      [`GET /api/documents/${DOC}/versions`]: () =>
        jsonResponse({ versions: [doc({ versionCount: 2, replacesDocumentId: older.id }), older] }),
    });
    await openTab(user);

    await user.click(
      await screen.findByRole('button', { name: 'Ver las versiones de laboratorio.pdf' }),
    );

    const dialog = await screen.findByRole('dialog', { name: /Versiones de «laboratorio.pdf»/ });
    const versions = await within(dialog).findAllByRole('listitem');
    expect(versions).toHaveLength(2);
    expect(within(versions[0] as HTMLElement).getByText('Actual')).toBeInTheDocument();
    expect(within(versions[1] as HTMLElement).queryByText('Actual')).toBeNull();
  });

  it('asks for the hidden documents only when the person wants to see them', async () => {
    const user = userEvent.setup();
    const asked: string[] = [];
    open((url) => {
      asked.push(url);
      return jsonResponse({
        documents: url.includes('includeHidden=true')
          ? [
              doc({
                status: 'hidden',
                hidden: { at: '2026-10-16T16:00:00.000Z', reason: 'Paciente equivocado' },
              }),
            ]
          : [doc({ id: '0190a000-0000-7000-8000-0000000000d9', name: 'visible.pdf' })],
      });
    });
    await openTab(user);
    expect(await screen.findByText('visible.pdf')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Mostrar documentos ocultos' }));

    expect(await screen.findByText(/Oculto: Paciente equivocado/)).toBeInTheDocument();
    expect(screen.getByText(/no se borran/i)).toBeInTheDocument();
    expect(asked.some((url) => url.includes('includeHidden=true'))).toBe(true);
    expect(asked.some((url) => !url.includes('includeHidden'))).toBe(true);
  });

  it('shows an empty state that explains what documents are for, with the upload button for whoever can upload', async () => {
    const user = userEvent.setup();
    open([]);
    await openTab(user);

    expect(
      await screen.findByRole('heading', { name: 'Todavía no hay documentos' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subir archivos' })).toBeInTheDocument();
  });

  it('shows the error with a retry when the list cannot be loaded', async () => {
    const user = userEvent.setup();
    let calls = 0;
    open(() => {
      calls += 1;
      return calls === 1
        ? problemResponse(500, 'internal_error')
        : jsonResponse({ documents: [doc()] });
    });
    await openTab(user);

    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('laboratorio.pdf')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const user = userEvent.setup();
    const app = open([
      doc(),
      doc({
        id: '0190a000-0000-7000-8000-0000000000d2',
        status: 'quarantined',
        name: 'b.pdf',
        contentType: null,
      }),
      doc({
        id: '0190a000-0000-7000-8000-0000000000d3',
        status: 'rejected',
        rejectionReason: 'corrupt',
        name: 'c.pdf',
      }),
    ]);
    await openTab(user);
    await screen.findByRole('list', { name: 'Documentos del paciente' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('downloading', () => {
  it('asks for a link, follows it with this session, and hands the file to the browser', async () => {
    const user = userEvent.setup();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const app = open([doc()], {
      [`POST /api/documents/${DOC}/download-link`]: () =>
        jsonResponse({ url: `/files/${TOKEN}`, expiresAt: '2026-10-16T15:05:00.000Z' }),
      [`GET /api/files/${TOKEN}`]: () =>
        new Response(new Uint8Array([37, 80, 68, 70]), {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename="laboratorio.pdf"`,
          },
        }),
    });
    await openTab(user);

    await user.click(await screen.findByRole('button', { name: 'Descargar laboratorio.pdf' }));

    await waitFor(() => {
      expect(click).toHaveBeenCalledTimes(1);
    });
    const requests = app.requests.filter((request) => /download-link|\/files\//.test(request));
    expect(requests).toEqual([
      `POST /api/documents/${DOC}/download-link`,
      `GET /api/files/${TOKEN}`,
    ]);
    expect(await screen.findByText('La descarga empezó.')).toBeInTheDocument();
    click.mockRestore();
  });

  it('tells the person when the download fails, without technical detail', async () => {
    const user = userEvent.setup();
    open([doc()], {
      [`POST /api/documents/${DOC}/download-link`]: () => problemResponse(403, 'forbidden'),
    });
    await openTab(user);

    await user.click(await screen.findByRole('button', { name: 'Descargar laboratorio.pdf' }));

    expect(await screen.findByText(/No tiene permiso/i)).toBeInTheDocument();
  });

  it('does not offer a clinical download to someone who may not read clinical documents', async () => {
    const user = userEvent.setup();
    open(
      [
        doc({ classification: 'clinical' }),
        doc({
          id: '0190a000-0000-7000-8000-0000000000d2',
          name: 'dni.pdf',
          classification: 'administrative',
          category: 'id_copy',
        }),
      ],
      {},
      'admin',
    );
    await openTab(user);

    expect(await screen.findByRole('button', { name: 'Descargar dni.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Descargar laboratorio.pdf' })).toBeNull();
  });
});

describe('uploading', () => {
  const created = (
    ids: string[],
    duplicateOf: Record<number, { id: string; name: string }> = {},
  ) => ({
    uploads: ids.map((id, index) => ({
      id,
      name: `archivo-${String(index)}.pdf`,
      upload: {
        url: `https://files.example.test/${id}`,
        fields: { key: `t/x/quarantine/${id}`, 'Content-Type': 'application/pdf' },
        expiresAt: '2026-10-16T15:15:00.000Z',
      },
      duplicateOf: duplicateOf[index]
        ? { ...duplicateOf[index], uploadedAt: '2026-10-01T10:00:00.000Z' }
        : null,
    })),
  });

  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await openTab(user);
    await user.click(await screen.findByRole('button', { name: 'Subir archivos' }));
    return screen.findByRole('dialog', { name: 'Subir archivos' });
  }

  it('uploads several files with progress: request, direct upload to storage, confirmation', async () => {
    const user = anyFile();
    let request: CreateUploadsRequest | undefined;
    const confirmed: string[] = [];
    const app = open([], {
      'POST /api/documents/uploads': (_url, init) => {
        request = jsonBody(init) as CreateUploadsRequest;
        return jsonResponse(created([U1, U2]));
      },
      [`POST /api/documents/${U1}/uploaded`]: () => {
        confirmed.push(U1);
        return jsonResponse(doc({ id: U1 }));
      },
      [`POST /api/documents/${U2}/uploaded`]: () => {
        confirmed.push(U2);
        return jsonResponse(doc({ id: U2 }));
      },
    });
    const dialog = await openDialog(user);

    await user.upload(within(dialog).getByLabelText('Elegir archivos'), [
      pdf('a.pdf', 5000),
      pdf('b.pdf', 8000),
    ]);
    expect(within(dialog).getByText('a.pdf')).toBeInTheDocument();
    expect(within(dialog).getByText('b.pdf')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Subir' }));

    await waitFor(() => {
      expect(FakeXhr.all).toHaveLength(2);
    });
    expect(request).toMatchObject({ patientId: ID, category: 'lab_result' });
    expect(request?.files.map((file) => file.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(request?.files.map((file) => file.size)).toEqual([5000, 8000]);
    expect(request?.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(FakeXhr.all[0]?.url).toBe(`https://files.example.test/${U1}`);
    expect(FakeXhr.all[0]?.body?.get('key')).toBe(`t/x/quarantine/${U1}`);
    expect(FakeXhr.all[0]?.withCredentials).toBe(false);

    FakeXhr.all[0]?.progress(40, 100);
    expect(
      await within(dialog).findByRole('progressbar', { name: 'Subiendo a.pdf' }),
    ).toHaveAttribute('value', '40');
    expect(within(dialog).getByText('40 %')).toBeInTheDocument();
    FakeXhr.all[0]?.finish(204);
    FakeXhr.all[1]?.finish(204);

    expect(await within(dialog).findByText(/Se subieron 2 archivos/)).toBeInTheDocument();
    expect(confirmed.sort()).toEqual([U1, U2]);
    expect(app.requests.filter((r) => r.endsWith('/uploaded'))).toHaveLength(2);
  });

  it('refuses files that cannot be uploaded before sending anything, with the reason of each', async () => {
    const user = anyFile();
    const app = open([]);
    const dialog = await openDialog(user);

    const tooBig = new File([new Uint8Array(10)], 'enorme.pdf', { type: 'application/pdf' });
    Object.defineProperty(tooBig, 'size', { value: 21 * 1024 * 1024 });
    await user.upload(within(dialog).getByLabelText('Elegir archivos'), [
      pdf('bien.pdf'),
      new File(['MZ'], 'programa.exe', { type: 'application/x-msdownload' }),
      tooBig,
    ]);

    expect(within(dialog).getByText('bien.pdf')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/«programa.exe» no es de un tipo permitido/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/«enorme.pdf» supera los 20 MB/)).toBeInTheDocument();
    expect(app.requests.filter((r) => r.includes('/documents/'))).toEqual([]);
  });

  it('takes ten files at most', async () => {
    const user = anyFile();
    open([]);
    const dialog = await openDialog(user);

    await user.upload(
      within(dialog).getByLabelText('Elegir archivos'),
      Array.from({ length: 11 }, (_, index) => pdf(`f${String(index)}.pdf`)),
    );

    expect(
      within(within(dialog).getByRole('list', { name: 'Archivos para subir' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(10);
    expect(
      within(dialog).getByText(/«f10.pdf» no se agregó: se pueden subir hasta 10 archivos/),
    ).toBeInTheDocument();
  });

  it('holds a duplicate until the person decides, and uploads it only if they say so', async () => {
    const user = anyFile();
    open([], {
      'POST /api/documents/uploads': () =>
        jsonResponse(created([U1, U2], { 0: { id: OLD, name: 'igual.pdf' } })),
      [`POST /api/documents/${U1}/uploaded`]: () => jsonResponse(doc({ id: U1 })),
      [`POST /api/documents/${U2}/uploaded`]: () => jsonResponse(doc({ id: U2 })),
    });
    const dialog = await openDialog(user);
    await user.upload(within(dialog).getByLabelText('Elegir archivos'), [
      pdf('copia.pdf'),
      pdf('nuevo.pdf'),
    ]);

    await user.click(within(dialog).getByRole('button', { name: 'Subir' }));

    // Only the new file went to storage; the copy waits for a decision.
    await waitFor(() => {
      expect(FakeXhr.all).toHaveLength(1);
    });
    expect(FakeXhr.all[0]?.url).toBe(`https://files.example.test/${U2}`);
    expect(await within(dialog).findByText('«copia.pdf» ya está cargado')).toBeInTheDocument();
    expect(within(dialog).getByText(/ya tiene un archivo igual: «igual.pdf»/)).toBeInTheDocument();
    FakeXhr.all[0]?.finish(204);

    await user.click(within(dialog).getByRole('button', { name: 'Subir de todos modos' }));
    await waitFor(() => {
      expect(FakeXhr.all).toHaveLength(2);
    });
    expect(FakeXhr.all[1]?.url).toBe(`https://files.example.test/${U1}`);
    FakeXhr.all[1]?.finish(204);
    expect(await within(dialog).findByText(/Se subieron 2 archivos/)).toBeInTheDocument();
  });

  it('lets the person discard a duplicate instead', async () => {
    const user = anyFile();
    open([], {
      'POST /api/documents/uploads': () =>
        jsonResponse(created([U1], { 0: { id: OLD, name: 'igual.pdf' } })),
    });
    const dialog = await openDialog(user);
    await user.upload(within(dialog).getByLabelText('Elegir archivos'), [pdf('copia.pdf')]);
    await user.click(within(dialog).getByRole('button', { name: 'Subir' }));

    await user.click(await within(dialog).findByRole('button', { name: 'Descartar' }));

    expect(within(dialog).queryByText('copia.pdf')).toBeNull();
    expect(FakeXhr.all).toHaveLength(0);
  });

  it('marks every file as failed with the server explanation when the request is refused, and allows a retry', async () => {
    const user = anyFile();
    let calls = 0;
    open([], {
      'POST /api/documents/uploads': () => {
        calls += 1;
        return calls === 1 ? problemResponse(403, 'forbidden') : jsonResponse(created([U1]));
      },
      [`POST /api/documents/${U1}/uploaded`]: () => jsonResponse(doc({ id: U1 })),
    });
    const dialog = await openDialog(user);
    await user.upload(within(dialog).getByLabelText('Elegir archivos'), [pdf('a.pdf')]);
    await user.click(within(dialog).getByRole('button', { name: 'Subir' }));

    expect(await within(dialog).findByText(/No tiene permiso/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => {
      expect(FakeXhr.all).toHaveLength(1);
    });
    FakeXhr.all[0]?.finish(204);

    expect(await within(dialog).findByText(/Se subió 1 archivo/)).toBeInTheDocument();
  });

  it('reports a file that storage refused, and one that lost the connection, each in its own words', async () => {
    const user = anyFile();
    open([], {
      'POST /api/documents/uploads': () => jsonResponse(created([U1, U2])),
    });
    const dialog = await openDialog(user);
    await user.upload(within(dialog).getByLabelText('Elegir archivos'), [
      pdf('a.pdf'),
      pdf('b.pdf'),
    ]);
    await user.click(within(dialog).getByRole('button', { name: 'Subir' }));
    await waitFor(() => {
      expect(FakeXhr.all).toHaveLength(2);
    });

    FakeXhr.all[0]?.finish(403);
    FakeXhr.all[1]?.onerror?.();

    expect(
      await within(dialog).findByText('El almacenamiento rechazó el archivo.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Se cortó la conexión/)).toBeInTheDocument();
    expect(within(dialog).getByText('2 sin subir.')).toBeInTheDocument();
  });

  it('offers reception the administrative categories only, and a professional both', async () => {
    const user = anyFile();
    open([], {}, 'reception');
    const reception = await openDialog(user);
    const options = within(reception)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toContain('Credencial de cobertura');
    expect(options).not.toContain('Resultado de laboratorio');
    expect(within(reception).queryByRole('group', { name: 'Clínicos' })).toBeNull();
  });

  it('offers a professional the clinical categories too', async () => {
    const user = anyFile();
    open([]);
    const dialog = await openDialog(user);

    const options = within(dialog)
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(options).toContain('Resultado de laboratorio');
    expect(options).toContain('Copia de documento de identidad');
  });

  it('has no accessibility violations with files in the list', async () => {
    const user = anyFile();
    open([]);
    const dialog = await openDialog(user);
    await user.upload(within(dialog).getByLabelText('Elegir archivos'), [pdf('a.pdf')]);

    expect(await a11yViolations(dialog)).toEqual([]);
  });
});

describe('uploading a new version', () => {
  it('opens for that document with its type fixed, and sends the link to the previous version', async () => {
    const user = anyFile();
    let request: CreateUploadsRequest | undefined;
    open([doc()], {
      'POST /api/documents/uploads': (_url, init) => {
        request = jsonBody(init) as CreateUploadsRequest;
        return jsonResponse({
          uploads: [
            {
              id: U9,
              name: 'laboratorio.pdf',
              upload: {
                url: `https://files.example.test/${U9}`,
                fields: { key: 'k' },
                expiresAt: '2026-10-16T15:15:00.000Z',
              },
              duplicateOf: null,
            },
          ],
        });
      },
      [`POST /api/documents/${U9}/uploaded`]: () => jsonResponse(doc({ id: U9 })),
    });
    await openTab(user);

    await user.click(
      await screen.findByRole('button', { name: 'Subir una nueva versión de laboratorio.pdf' }),
    );

    const dialog = await screen.findByRole('dialog', { name: 'Subir una nueva versión' });
    expect(within(dialog).getByText('Reemplaza a «laboratorio.pdf».')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Tipo de documento')).toBeDisabled();
    await user.upload(within(dialog).getByLabelText('Elegir archivos'), [pdf('v2.pdf')]);
    await user.click(within(dialog).getByRole('button', { name: 'Subir' }));
    await waitFor(() => {
      expect(FakeXhr.all).toHaveLength(1);
    });
    FakeXhr.all[0]?.finish(204);

    expect(await within(dialog).findByText(/Se subió 1 archivo/)).toBeInTheDocument();
    expect(request).toMatchObject({ replacesDocumentId: DOC, category: 'lab_result' });
  });
});

describe('hiding a document', () => {
  it('asks for a reason, says nothing is deleted, hides it, and refreshes the list', async () => {
    const user = anyFile();
    let hidden = false;
    let body: unknown;
    open(() => jsonResponse({ documents: hidden ? [] : [doc()] }), {
      [`POST /api/documents/${DOC}/hide`]: (_url, init) => {
        body = jsonBody(init);
        hidden = true;
        return jsonResponse(
          doc({
            status: 'hidden',
            hidden: { at: '2026-10-16T16:00:00.000Z', reason: 'Paciente equivocado' },
          }),
        );
      },
    });
    await openTab(user);

    await user.click(await screen.findByRole('button', { name: 'Ocultar laboratorio.pdf' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ocultar documento' });
    expect(within(dialog).getByText(/No se borra/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Ocultar documento' }));
    expect(
      await within(dialog).findByText(/Este dato es obligatorio|obligatorio/i),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Motivo'), 'Paciente equivocado');
    await user.click(within(dialog).getByRole('button', { name: 'Ocultar documento' }));

    expect(await screen.findByText('El documento se ocultó.')).toBeInTheDocument();
    expect(body).toEqual({ reason: 'Paciente equivocado' });
    await waitFor(() => {
      expect(screen.queryByText('laboratorio.pdf')).toBeNull();
    });
  });

  it('offers hide and replace to whoever can write that kind of document, and to nobody else', async () => {
    const user = anyFile();
    open([doc()], {}, 'reception');
    await openTab(user);

    expect(await screen.findByText('laboratorio.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ocultar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /nueva versión/ })).toBeNull();
  });
});
