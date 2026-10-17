import type {
  AppointmentDto,
  AuditAction,
  WorklistItemDto,
  WorklistResponse,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { worklistItem } from '../../src/db/schema/worklist.js';
import { createWorklistService } from '../../src/modules/scheduling/application/worklist.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

let runtime: DbHandle;
let world: SchedulingHttpWorld;
const worklist = () => createWorklistService({ keys: world.keys });

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSchedulingHttpWorld(runtime, { slug: 'sched-worklist' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const failure = (work: () => Promise<unknown>) =>
  work().then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

async function open(
  overrides: Partial<Parameters<ReturnType<typeof worklist>['openItem']>[1]> = {},
) {
  return world.inTenant((tx) =>
    worklist().openItem(tx, {
      kind: 'reminder_not_sent',
      subjectType: 'appointment',
      subjectId: uuidv7(),
      locationId: world.centro,
      ...overrides,
    }),
  );
}

async function auditRows(action: AuditAction) {
  return world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

const list = async (who = world.reception, query = '') =>
  (await world.api.get(`/worklist${query}`, who)).json<WorklistResponse>();

describe('the worklist table', () => {
  it('has the six canonical kinds and refuses any other', async () => {
    for (const kind of [
      'pending_approval',
      'identity_review',
      'reminder_not_sent',
      'reminder_not_delivered',
      'reply_to_review',
      'waitlist_manual_contact',
    ] as const) {
      expect((await open({ kind })).created).toBe(true);
    }

    const bad = failure(() =>
      world.inTenant((tx) =>
        tx.execute(
          sql`INSERT INTO worklist_item (tenant_id, kind, subject_type, subject_id) VALUES (${world.tenant.id}, 'newsletter', 'appointment', ${uuidv7()})`,
        ),
      ),
    );

    expect(await bad).toBe('23514');
  });

  it('refuses an unknown subject type and a status with no resolver', async () => {
    const insert = (subjectType: string, status: string) =>
      failure(() =>
        world.inTenant((tx) =>
          tx.execute(
            sql`INSERT INTO worklist_item (tenant_id, kind, subject_type, subject_id, status)
                VALUES (${world.tenant.id}, 'reminder_not_sent', ${subjectType}, ${uuidv7()}, ${status})`,
          ),
        ),
      );

    expect(await insert('patient', 'open')).toBe('23514');
    // A resolved item needs who and when.
    expect(await insert('appointment', 'resolved')).toBe('23514');
  });

  it('is never deleted', async () => {
    const { id } = await open();

    const deletion = await failure(() =>
      world.inTenant((tx) => tx.delete(worklistItem).where(eq(worklistItem.id, id))),
    );

    expect(deletion).toBe('42501');
  });

  it('cannot point at a location of another organization', async () => {
    const other = await createSchedulingHttpWorld(runtime, { slug: 'sched-worklist-b' });
    try {
      const code = await failure(() => open({ locationId: other.centro }));
      expect(code).toBe('23503');
    } finally {
      await other.close();
    }
  });
});

describe('opening an item', () => {
  it('is idempotent: the same kind and subject open once', async () => {
    const subjectId = uuidv7();

    const first = await open({ kind: 'reply_to_review', subjectId });
    const second = await open({ kind: 'reply_to_review', subjectId });

    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    const rows = await world.inTenant((tx) =>
      tx.select().from(worklistItem).where(eq(worklistItem.subjectId, subjectId)),
    );
    expect(rows).toHaveLength(1);
  });

  it('lets another kind, or the same kind once the first is closed, open a new item', async () => {
    const subjectId = uuidv7();
    const first = await open({ kind: 'reminder_not_delivered', subjectId });
    await world.api.post(`/worklist/${first.id}/resolve`, world.reception, {});

    const other = await open({ kind: 'reminder_not_sent', subjectId });
    const again = await open({ kind: 'reminder_not_delivered', subjectId });

    expect(other.created).toBe(true);
    expect(again.created).toBe(true);
    expect(again.id).not.toBe(first.id);
  });

  it('encrypts the detail at rest and shows it to staff who can use the worklist', async () => {
    const { id } = await open({
      kind: 'identity_review',
      detail: { phone: '1155550000', email: 'otra@example.test' },
    });

    const [row] = await world.inTenant((tx) =>
      tx.select().from(worklistItem).where(eq(worklistItem.id, id)),
    );
    const raw = row?.detailEnc?.toString('utf8') ?? '';
    const item = (await list(world.admin, '?kind=identity_review')).items.find((i) => i.id === id);

    expect(row?.detailEnc).not.toBeNull();
    expect(raw).not.toContain('1155550000');
    expect(raw).not.toContain('otra@example.test');
    expect(item?.detail).toEqual({ phone: '1155550000', email: 'otra@example.test' });
  });
});

describe('GET /worklist', () => {
  it('shows reception the items of the locations it works at, and owner and admin all of them', async () => {
    const centroItem = await open({ locationId: world.centro });
    const norteItem = await open({ locationId: world.norte });
    const orgItem = await open({ locationId: undefined });

    const receptionSees = (await list(world.reception)).items.map((item) => item.id);
    const adminSees = (await list(world.admin)).items.map((item) => item.id);

    expect(receptionSees).toContain(centroItem.id);
    expect(receptionSees).toContain(orgItem.id);
    expect(receptionSees).not.toContain(norteItem.id);
    expect(adminSees).toEqual(expect.arrayContaining([centroItem.id, norteItem.id, orgItem.id]));
  });

  it('lists items of several capabilities in one place, each with its kind and what can be done', async () => {
    const created = await world.book(1, '10:00');
    await open({ kind: 'pending_approval', subjectId: created.id });
    await open({ kind: 'reminder_not_delivered' });
    await open({ kind: 'waitlist_manual_contact', subjectType: 'waitlist_entry' });

    const response = await list(world.reception);

    const kinds = new Set(response.items.map((item) => item.kind));
    expect(kinds.has('pending_approval')).toBe(true);
    expect(kinds.has('waitlist_manual_contact')).toBe(true);
    const approval = response.items.find((item) => item.subjectId === created.id);
    expect(approval?.actions).toEqual(
      expect.arrayContaining(['open_appointment', 'approve', 'dismiss']),
    );
  });

  it('shows only administrative data of the appointment an item is about', async () => {
    const created = await world.book(2, '10:00');
    await open({ kind: 'pending_approval', subjectId: created.id });

    const item = (await list(world.reception, '?kind=pending_approval')).items.find(
      (candidate) => candidate.subjectId === created.id,
    );

    expect(item?.appointment).toMatchObject({
      id: created.id,
      startsAt: created.startsAt,
      status: 'scheduled',
      professionalId: world.doctor.professionalId,
      locationId: world.centro,
      version: created.version,
    });
    expect(Object.keys(item?.appointment ?? {}).sort()).toEqual(
      [
        'endsAt',
        'id',
        'identityConfirmed',
        'locationId',
        'patientId',
        'patientName',
        'professionalId',
        'startsAt',
        'status',
        'version',
      ].sort(),
    );
  });

  it('filters by status and kind, and counts what is open', async () => {
    const stale = await open({ kind: 'reply_to_review' });
    await world.api.post(`/worklist/${stale.id}/dismiss`, world.reception, {});

    const open_ = await list(world.reception);
    const dismissed = await list(world.reception, '?status=dismissed&kind=reply_to_review');

    expect(open_.items.every((item) => item.status === 'open')).toBe(true);
    expect(open_.openCount).toBeGreaterThanOrEqual(open_.items.length);
    expect(dismissed.items.map((item) => item.id)).toContain(stale.id);
  });

  it('is for staff who manage the worklist, not for a professional', async () => {
    expect((await world.api.get('/worklist', world.doctor)).statusCode).toBe(403);
    expect((await world.api.get('/worklist', null)).statusCode).toBe(401);
  });
});

describe('resolving and dismissing', () => {
  it('records who and when, keeps the item, and audits it', async () => {
    const { id } = await open({ kind: 'reminder_not_sent' });

    const response = await world.api.post(`/worklist/${id}/resolve`, world.reception, {});

    expect(response.statusCode).toBe(200);
    expect(response.json<WorklistItemDto>()).toMatchObject({
      id,
      status: 'resolved',
      resolvedBy: world.reception.user.id,
      resolution: 'handled',
    });
    const [row] = await world.inTenant((tx) =>
      tx.select().from(worklistItem).where(eq(worklistItem.id, id)),
    );
    expect(row?.resolvedAt).toBeInstanceOf(Date);
    expect((await auditRows('worklist.resolved'))[0]).toMatchObject({
      resourceType: 'worklist_item',
      resourceId: id,
      actorUserId: world.reception.user.id,
      metadata: { kind: 'reminder_not_sent' },
    });
  });

  it('dismisses an item the same way, and closing twice is a conflict', async () => {
    const { id } = await open({ kind: 'waitlist_manual_contact', subjectType: 'waitlist_entry' });

    const dismissed = await world.api.post(`/worklist/${id}/dismiss`, world.admin, {});
    const again = await world.api.post(`/worklist/${id}/resolve`, world.admin, {});

    expect(dismissed.json<WorklistItemDto>()).toMatchObject({
      status: 'dismissed',
      resolution: 'dismissed',
    });
    expect(again.statusCode).toBe(409);
    expect((await auditRows('worklist.dismissed'))[0]).toMatchObject({ resourceId: id });
  });

  it('hides an item of another location from reception, as if it did not exist', async () => {
    const { id } = await open({ locationId: world.norte });

    expect((await world.api.post(`/worklist/${id}/resolve`, world.reception, {})).statusCode).toBe(
      404,
    );
    expect((await world.api.post(`/worklist/${id}/resolve`, world.admin, {})).statusCode).toBe(200);
  });

  it('leaves an identity review to the identity actions, not to a plain resolve', async () => {
    const { id } = await open({ kind: 'identity_review' });

    const resolve = await world.api.post(`/worklist/${id}/resolve`, world.admin, {});
    const dismiss = await world.api.post(`/worklist/${id}/dismiss`, world.admin, {});

    expect(resolve.statusCode).toBe(409);
    expect(dismiss.statusCode).toBe(409);
  });

  it('is refused to a professional and to an unknown id', async () => {
    const { id } = await open();

    expect((await world.api.post(`/worklist/${id}/resolve`, world.doctor, {})).statusCode).toBe(
      403,
    );
    expect(
      (await world.api.post(`/worklist/${uuidv7()}/resolve`, world.admin, {})).statusCode,
    ).toBe(404);
  });

  it('is refused while the organization is read-only', async () => {
    const { id } = await open();
    await world.inTenant((tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, world.tenant.id)),
    );
    try {
      expect(
        (await world.api.post(`/worklist/${id}/resolve`, world.reception, {})).statusCode,
      ).toBe(402);
      expect((await world.api.get('/worklist', world.reception)).statusCode).toBe(200);
    } finally {
      await world.inTenant((tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, world.tenant.id)),
      );
    }
  });
});

describe('the appointment type of the world', () => {
  it('keeps booking working next to the worklist (sanity)', async () => {
    const created: AppointmentDto = await world.book(3, '10:00');

    expect(created.status).toBe('scheduled');
  });
});
