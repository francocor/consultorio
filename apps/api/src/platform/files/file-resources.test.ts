import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '../db/tenant-context.js';

import {
  FileRefused,
  createFileResourceRegistry,
  type FileDelivery,
  type FileRedeemInput,
  type FileResource,
} from './file-resources.js';

const tx = {} as Tx;
const input = {
  actor: {} as FileRedeemInput['actor'],
  auditActor: {} as FileRedeemInput['auditActor'],
  sessionId: '0190a000-0000-7000-8000-000000000001',
  token: 'a'.repeat(43),
} satisfies FileRedeemInput;

const delivery = (objectKey: string): FileDelivery => ({
  objectKey,
  contentType: 'application/pdf',
  contentDisposition: 'attachment; filename="x.pdf"',
});

function resource(
  kind: FileResource['kind'],
  redeem: FileResource['redeem'],
  audits: FileResource['audits'] = [],
): FileResource {
  return { kind, audits, redeem };
}

describe('the file resource registry (what /files/:token serves)', () => {
  it('serves the file of the resource whose link it is', async () => {
    const registry = createFileResourceRegistry();
    registry.register(resource('document_download', () => Promise.resolve(null)));
    registry.register(
      resource('export_download', () => Promise.resolve(delivery('t/x/exports/1'))),
    );

    await expect(registry.redeem(tx, input)).resolves.toEqual(delivery('t/x/exports/1'));
  });

  it('asks the resources in the order they registered, and stops at the first that knows the link', async () => {
    const registry = createFileResourceRegistry();
    const first = vi.fn(() => Promise.resolve(delivery('first')));
    const second = vi.fn(() => Promise.resolve(delivery('second')));
    registry.register(resource('document_download', first));
    registry.register(resource('invoice_pdf', second));

    await registry.redeem(tx, input);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('fails closed for a link no resource recognizes: an unknown kind is refused like any bad link', async () => {
    const registry = createFileResourceRegistry();
    registry.register(resource('document_download', () => Promise.resolve(null)));

    await expect(registry.redeem(tx, input)).rejects.toMatchObject({
      name: 'FileRefused',
      reason: 'file_link_invalid',
      resourceType: 'file',
    });
  });

  it('fails closed when nothing is registered at all', async () => {
    await expect(createFileResourceRegistry().redeem(tx, input)).rejects.toBeInstanceOf(
      FileRefused,
    );
  });

  it('lets a refusal of the resource that owns the link through, with what it knew', async () => {
    const registry = createFileResourceRegistry();
    registry.register(
      resource('invoice_pdf', () => {
        throw new FileRefused('invoice_not_readable', 'invoice', { resourceId: 'inv-1' });
      }),
    );

    await expect(registry.redeem(tx, input)).rejects.toMatchObject({
      reason: 'invoice_not_readable',
      resourceType: 'invoice',
      context: { resourceId: 'inv-1' },
    });
  });

  it('does not hide a failure that is not a refusal behind the generic answer', async () => {
    const registry = createFileResourceRegistry();
    registry.register(
      resource('export_download', () => Promise.reject(new Error('the database is down'))),
    );

    await expect(registry.redeem(tx, input)).rejects.toThrow('the database is down');
  });

  it('refuses two resources for one kind: the second would silently take the links of the first', () => {
    const registry = createFileResourceRegistry();
    registry.register(resource('document_download', () => Promise.resolve(null)));

    expect(() => {
      registry.register(resource('document_download', () => Promise.resolve(null)));
    }).toThrow(/document_download/);
  });

  it('refuses a kind of link that is not a download: a reset link must never open a file', () => {
    const registry = createFileResourceRegistry();

    expect(() => {
      registry.register(resource('password_reset' as never, () => Promise.resolve(null)));
    }).toThrow(/password_reset/);
  });

  it('lists the audit actions its resources write, once each, for the route to declare', () => {
    const registry = createFileResourceRegistry();
    registry.register(
      resource('document_download', () => Promise.resolve(null), ['document.downloaded']),
    );
    registry.register(
      resource('export_download', () => Promise.resolve(null), [
        'document.downloaded',
        'export.requested',
      ]),
    );

    expect(registry.audits()).toEqual(['document.downloaded', 'export.requested']);
    expect(registry.kinds()).toEqual(['document_download', 'export_download']);
  });
});
