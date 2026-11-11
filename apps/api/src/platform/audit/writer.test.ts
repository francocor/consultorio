import type { AuditAction } from '@consultorio/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '../db/tenant-context.js';

import { audit, type AuditActor } from './writer.js';

const ACTOR: AuditActor = {
  userId: '0190a000-0000-7000-8000-0000000000f1',
  actingRole: 'professional',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  requestId: '0190a000-0000-7000-8000-0000000000c1',
};

/** A transaction double that records what the writer asked it to insert. */
function fakeTx() {
  const values = vi.fn((row: unknown) => {
    rows.push(row);
    return Promise.resolve();
  });
  const rows: unknown[] = [];
  const tx = { insert: vi.fn(() => ({ values })) } as unknown as Tx;
  return { tx, rows, values };
}

describe('audit() input validation (before the database is touched)', () => {
  it('writes one row carrying the actor, the resource and the validated metadata', async () => {
    const { tx, rows } = fakeTx();

    await audit(tx, {
      action: 'clinical.note.read',
      outcome: 'allow',
      actor: ACTOR,
      resourceType: 'clinical_note',
      resourceId: '0190a000-0000-7000-8000-0000000000d1',
      patientId: '0190a000-0000-7000-8000-0000000000d2',
      reason: 'treating',
      metadata: { version: 2, changedFields: ['phone'] },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'clinical.note.read',
      outcome: 'allow',
      actorUserId: ACTOR.userId,
      actingRole: 'professional',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      requestId: ACTOR.requestId,
      resourceType: 'clinical_note',
      reason: 'treating',
      metadata: { version: 2, changedFields: ['phone'] },
    });
  });

  it('writes nulls for an anonymous actor and an empty metadata object by default', async () => {
    const { tx, rows } = fakeTx();

    await audit(tx, {
      action: 'auth.login.failed',
      outcome: 'deny',
      actor: { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null },
    });

    expect(rows[0]).toMatchObject({
      actorUserId: null,
      actingRole: null,
      ip: null,
      resourceId: null,
      patientId: null,
      metadata: {},
    });
  });

  it('refuses an action that is not in the catalogue and never touches the transaction', async () => {
    const { tx, values } = fakeTx();

    await expect(
      audit(tx, {
        action: 'made.up.action' as AuditAction,
        outcome: 'allow',
        actor: ACTOR,
      }),
    ).rejects.toThrow(/unknown audit action/);
    expect(values).not.toHaveBeenCalled();
  });

  it('refuses metadata that carries clinical content or secrets', async () => {
    const { tx, values } = fakeTx();

    await expect(
      audit(tx, {
        action: 'clinical.note.updated',
        outcome: 'allow',
        actor: ACTOR,
        metadata: { content: 'patient reports chest pain' },
      }),
    ).rejects.toThrow();
    await expect(
      audit(tx, {
        action: 'auth.login.failed',
        outcome: 'deny',
        actor: ACTOR,
        metadata: { password: 'hunter2' },
      }),
    ).rejects.toThrow();
    expect(values).not.toHaveBeenCalled();
  });

  it('does not put the rejected value into the error message', async () => {
    const { tx } = fakeTx();

    const error = await audit(tx, {
      action: 'clinical.note.updated',
      outcome: 'allow',
      actor: ACTOR,
      metadata: { content: 'patient reports chest pain' },
    }).catch((caught: unknown) => caught);

    expect(String(error)).not.toContain('chest pain');
  });

  it('truncates an oversized user agent instead of failing the action', async () => {
    const { tx, rows } = fakeTx();

    await audit(tx, {
      action: 'auth.login.success',
      outcome: 'allow',
      actor: { ...ACTOR, userAgent: 'x'.repeat(2000) },
    });

    expect((rows[0] as { userAgent: string }).userAgent).toHaveLength(512);
  });

  it('lets a database failure propagate (fail closed, nothing is swallowed)', async () => {
    const tx = {
      insert: () => ({ values: () => Promise.reject(new Error('audit store down')) }),
    } as unknown as Tx;

    await expect(
      audit(tx, { action: 'auth.logout', outcome: 'allow', actor: ACTOR }),
    ).rejects.toThrow('audit store down');
  });
});
