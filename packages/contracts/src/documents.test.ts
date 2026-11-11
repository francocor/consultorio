import { describe, expect, it } from 'vitest';

import {
  CreateUploadsRequest,
  DOCUMENT_CATEGORIES,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_FILES_PER_REQUEST,
  HideDocumentRequest,
  ReclassifyDocumentRequest,
  classificationOf,
  isClinicalCategory,
} from './documents.js';

const patientId = '0190a000-0000-7000-8000-000000000001';

const file = (overrides: Record<string, unknown> = {}) => ({
  name: 'resultado.pdf',
  contentType: 'application/pdf',
  size: 2_000_000,
  ...overrides,
});

describe('document categories', () => {
  it('belong to exactly one classification, which the server derives (the client never sends it)', () => {
    expect(classificationOf('lab_result')).toBe('clinical');
    expect(classificationOf('imaging')).toBe('clinical');
    expect(classificationOf('id_copy')).toBe('administrative');
    expect(classificationOf('coverage_card')).toBe('administrative');
    expect(isClinicalCategory('referral')).toBe(true);
    expect(isClinicalCategory('signed_form')).toBe(false);
  });

  it('has no category in both classifications', () => {
    const clinical: readonly string[] = DOCUMENT_CATEGORIES.clinical;
    const administrative: readonly string[] = DOCUMENT_CATEGORIES.administrative;
    expect(clinical.filter((category) => administrative.includes(category))).toEqual([]);
    expect(clinical.length).toBeGreaterThan(0);
    expect(administrative.length).toBeGreaterThan(0);
  });
});

describe('CreateUploadsRequest', () => {
  const valid = { patientId, category: 'lab_result', files: [file()] };

  it('accepts one file of an allowed type, with optional links to an encounter and an appointment', () => {
    const parsed = CreateUploadsRequest.safeParse({
      ...valid,
      encounterId: '0190a000-0000-7000-8000-000000000002',
      appointmentId: '0190a000-0000-7000-8000-000000000003',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the maximum number of files and refuses one more', () => {
    const files = (count: number) =>
      Array.from({ length: count }, (_, i) => file({ name: `f${String(i)}.pdf` }));

    expect(
      CreateUploadsRequest.safeParse({ ...valid, files: files(DOCUMENT_MAX_FILES_PER_REQUEST) })
        .success,
    ).toBe(true);
    expect(
      CreateUploadsRequest.safeParse({ ...valid, files: files(DOCUMENT_MAX_FILES_PER_REQUEST + 1) })
        .success,
    ).toBe(false);
    expect(CreateUploadsRequest.safeParse({ ...valid, files: [] }).success).toBe(false);
  });

  it('refuses a file above the size cap, an empty file and a type outside the whitelist', () => {
    expect(
      CreateUploadsRequest.safeParse({ ...valid, files: [file({ size: DOCUMENT_MAX_BYTES })] })
        .success,
    ).toBe(true);
    expect(
      CreateUploadsRequest.safeParse({ ...valid, files: [file({ size: DOCUMENT_MAX_BYTES + 1 })] })
        .success,
    ).toBe(false);
    expect(CreateUploadsRequest.safeParse({ ...valid, files: [file({ size: 0 })] }).success).toBe(
      false,
    );
    expect(
      CreateUploadsRequest.safeParse({
        ...valid,
        files: [file({ contentType: 'application/x-msdownload' })],
      }).success,
    ).toBe(false);
    expect(
      CreateUploadsRequest.safeParse({ ...valid, files: [file({ contentType: 'image/svg+xml' })] })
        .success,
    ).toBe(false);
  });

  it('reports which file and which field is wrong, with a translation key and not the value', () => {
    const parsed = CreateUploadsRequest.safeParse({
      ...valid,
      files: [file(), file({ size: DOCUMENT_MAX_BYTES + 1 })],
    });

    expect(parsed.success).toBe(false);
    const paths = parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('files.1.size');
  });

  it('takes the name as text only: no path separators matter here, the server never uses it as a path', () => {
    const parsed = CreateUploadsRequest.safeParse({
      ...valid,
      files: [file({ name: '../../otro/archivo.pdf' })],
    });
    expect(parsed.success).toBe(true);
    expect(CreateUploadsRequest.safeParse({ ...valid, files: [file({ name: '' })] }).success).toBe(
      false,
    );
    expect(
      CreateUploadsRequest.safeParse({ ...valid, files: [file({ name: 'x'.repeat(256) })] })
        .success,
    ).toBe(false);
  });

  it('allows a replacement only for a single file', () => {
    const replaces = '0190a000-0000-7000-8000-000000000009';

    expect(CreateUploadsRequest.safeParse({ ...valid, replacesDocumentId: replaces }).success).toBe(
      true,
    );
    expect(
      CreateUploadsRequest.safeParse({
        ...valid,
        replacesDocumentId: replaces,
        files: [file(), file({ name: 'otro.pdf' })],
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown category, an unknown member and a tenant identifier', () => {
    expect(CreateUploadsRequest.safeParse({ ...valid, category: 'selfie' }).success).toBe(false);
    expect(
      CreateUploadsRequest.safeParse({ ...valid, classification: 'administrative' }).success,
    ).toBe(false);
    expect(CreateUploadsRequest.safeParse({ ...valid, tenantId: patientId }).success).toBe(false);
  });

  it('takes an optional SHA-256 hint in hexadecimal, so duplicates can be warned about before sending', () => {
    const hash = 'a'.repeat(64);
    expect(
      CreateUploadsRequest.safeParse({ ...valid, files: [file({ sha256: hash })] }).success,
    ).toBe(true);
    expect(
      CreateUploadsRequest.safeParse({ ...valid, files: [file({ sha256: 'xyz' })] }).success,
    ).toBe(false);
  });
});

describe('hide and reclassify requests', () => {
  it('require a reason to hide, and a known category to reclassify', () => {
    expect(HideDocumentRequest.safeParse({ reason: 'Paciente equivocado' }).success).toBe(true);
    expect(HideDocumentRequest.safeParse({ reason: '   ' }).success).toBe(false);
    expect(HideDocumentRequest.safeParse({}).success).toBe(false);
    expect(ReclassifyDocumentRequest.safeParse({ category: 'imaging' }).success).toBe(true);
    expect(ReclassifyDocumentRequest.safeParse({ category: 'nope' }).success).toBe(false);
  });
});
