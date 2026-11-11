import { describe, expect, it, vi } from 'vitest';

import type { PortalActor } from '../authz/actor.js';
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

describe('the registry of the patient portal (a door of its own, with the portal actor)', () => {
  const portalActor: PortalActor = {
    kind: 'portal',
    tenantId: '0190a000-0000-7000-8000-0000000000e1',
    identityId: '0190a000-0000-7000-8000-0000000000c1',
    linkId: '0190a000-0000-7000-8000-0000000000c2',
  };
  const portalInput = { ...input, actor: portalActor } satisfies FileRedeemInput<PortalActor>;

  const portalResource = (
    kind: FileResource['kind'],
    redeem: FileResource<PortalActor>['redeem'],
  ): FileResource<PortalActor> => ({ kind, audits: ['portal.download'], redeem });

  it('keeps the resources of the portal apart from the staff ones, even for the same kind of link', async () => {
    const staff = createFileResourceRegistry();
    const portal = createFileResourceRegistry<PortalActor>();
    staff.register(resource('document_download', () => Promise.resolve(delivery('staff-file'))));
    portal.register(
      portalResource('document_download', () => Promise.resolve(delivery('portal-file'))),
    );

    await expect(portal.redeem(tx, portalInput)).resolves.toEqual(delivery('portal-file'));
    await expect(staff.redeem(tx, input)).resolves.toEqual(delivery('staff-file'));
  });

  it('hands the resource the portal actor of the session, so it can authorize the subject again', async () => {
    const portal = createFileResourceRegistry<PortalActor>();
    const redeem = vi.fn((_tx: Tx, received: FileRedeemInput<PortalActor>) =>
      Promise.resolve(delivery(received.actor.linkId ?? 'no-subject')),
    );
    portal.register(portalResource('document_download', redeem));

    await expect(portal.redeem(tx, portalInput)).resolves.toEqual(
      delivery('0190a000-0000-7000-8000-0000000000c2'),
    );
    expect(redeem).toHaveBeenCalledWith(tx, portalInput);
  });

  it('fails closed for a link that only a staff resource would open', async () => {
    const staff = createFileResourceRegistry();
    const portal = createFileResourceRegistry<PortalActor>();
    staff.register(resource('document_download', () => Promise.resolve(delivery('staff-file'))));

    await expect(portal.redeem(tx, portalInput)).rejects.toMatchObject({
      reason: 'file_link_invalid',
    });
  });

  it('declares the audit actions of its own resources, not the staff ones', () => {
    const staff = createFileResourceRegistry();
    const portal = createFileResourceRegistry<PortalActor>();
    staff.register(
      resource('document_download', () => Promise.resolve(null), ['document.downloaded']),
    );
    portal.register(portalResource('document_download', () => Promise.resolve(null)));

    expect(portal.audits()).toEqual(['portal.download']);
    expect(staff.audits()).toEqual(['document.downloaded']);
  });
});
