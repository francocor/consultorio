import type { CreateUploadsRequest, CreateUploadsResponse } from '@consultorio/contracts';
import { describe, expect, it, vi } from 'vitest';

import { registerFiles, sha256Hex } from './upload-flow.js';

const PDF = 'application/pdf';
const file = (name: string, content = 'contenido') => new File([content], name, { type: PDF });

function created(...ids: string[]): CreateUploadsResponse {
  return {
    uploads: ids.map((id) => ({
      id,
      name: `${id}.pdf`,
      upload: {
        url: `https://files.example.test/${id}`,
        fields: { key: `quarantine/${id}` },
        expiresAt: '2026-03-02T12:15:00.000Z',
      },
      duplicateOf: null,
    })),
  };
}

describe('sha256Hex: the hash the browser sends so a duplicate is noticed before the upload', () => {
  it('is the SHA-256 of the content in hexadecimal', async () => {
    // The well-known hash of the ASCII text "abc".
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex(new Blob(['abd']))).not.toBe(await sha256Hex(new Blob(['abc'])));
  });
});

type Uploader = (request: CreateUploadsRequest) => Promise<CreateUploadsResponse>;

describe('registerFiles: ask the server to prepare the uploads', () => {
  it('sends one request for every file, in order, with the hash of each, and maps the answers by position', async () => {
    const createUploads = vi.fn<Uploader>(() => {
      return Promise.resolve(created('doc-a', 'doc-b'));
    });
    const entries = [
      { key: 'k1', file: file('a.pdf', 'uno'), contentType: PDF },
      { key: 'k2', file: file('b.pdf', 'dos'), contentType: PDF },
    ] as const;

    const result = await registerFiles(
      { createUploads },
      { patientId: 'p1', category: 'lab_result', entries },
    );

    expect(createUploads).toHaveBeenCalledTimes(1);
    const request = createUploads.mock.calls[0]?.[0];
    expect(request).toMatchObject({ patientId: 'p1', category: 'lab_result' });
    expect(request?.files.map((item) => item.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(request?.files.map((item) => item.size)).toEqual([3, 3]);
    expect(request?.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(request?.files[0]?.sha256).not.toBe(request?.files[1]?.sha256);
    expect(result.get('k1')?.documentId).toBe('doc-a');
    expect(result.get('k2')?.post.url).toBe('https://files.example.test/doc-b');
  });

  it('carries the document being replaced, and reports a duplicate the server found', async () => {
    const createUploads = vi.fn<Uploader>(() => {
      const response = created('doc-c');
      const [first] = response.uploads;
      if (first)
        first.duplicateOf = {
          id: 'old',
          name: 'igual.pdf',
          uploadedAt: '2026-03-01T10:00:00.000Z',
        };
      return Promise.resolve(response);
    });

    const result = await registerFiles(
      { createUploads },
      {
        patientId: 'p1',
        category: 'imaging',
        replacesDocumentId: 'prev',
        entries: [{ key: 'k', file: file('c.pdf'), contentType: PDF }],
      },
    );

    expect(createUploads.mock.calls[0]?.[0].replacesDocumentId).toBe('prev');
    expect(result.get('k')?.duplicateOf).toEqual({ id: 'old', name: 'igual.pdf' });
  });

  it('still registers when the hash cannot be computed, just without the duplicate warning', async () => {
    const createUploads = vi.fn<Uploader>(() => {
      return Promise.resolve(created('doc-d'));
    });

    await registerFiles(
      { createUploads },
      {
        patientId: 'p1',
        category: 'lab_result',
        entries: [{ key: 'k', file: file('d.pdf'), contentType: PDF }],
      },
      () => Promise.resolve(undefined),
    );

    expect(createUploads.mock.calls[0]?.[0].files[0]).not.toHaveProperty('sha256');
  });

  it('fails the whole registration when the server refuses it', async () => {
    const createUploads = vi.fn(() => Promise.reject(new Error('refused')));

    await expect(
      registerFiles(
        { createUploads },
        {
          patientId: 'p1',
          category: 'lab_result',
          entries: [{ key: 'k', file: file('e.pdf'), contentType: PDF }],
        },
      ),
    ).rejects.toThrow('refused');
  });
});
