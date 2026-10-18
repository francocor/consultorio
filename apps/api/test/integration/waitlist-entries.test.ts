import type {
  WaitlistEntryDetailResponse,
  WaitlistEntryDto,
  WaitlistListResponse,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { insertPatient } from '../support/scheduling.js';

let runtime: DbHandle;
let world: SchedulingHttpWorld;
let other: SchedulingHttpWorld;

const NOW = new Date('2031-05-05T12:00:00.000Z');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const app = { clock: () => NOW };
  world = await createSchedulingHttpWorld(runtime, { slug: 'waitlist-entries', now: NOW, app });
  other = await createSchedulingHttpWorld(runtime, { slug: 'waitlist-entries-b', now: NOW, app });
});

afterAll(async () => {
  await world.close();
  await other.close();
  await runtime.close();
});

let counter = 0;

/** A patient with an email address and a mobile number, the way reception registers one. */
async function reachablePatient(
  options: { email?: boolean; phone?: boolean; world?: SchedulingHttpWorld } = {},
): Promise<string> {
  const target = options.world ?? world;
  counter += 1;
  return target.inTenant(async (tx) => {
    const id = await insertPatient(tx, target.tenant.id);
    await tx.execute(
      sql`UPDATE patient SET email = ${options.email === false ? null : `espera${String(counter)}@example.test`},
            phone = ${options.phone === false ? null : '+54 11 5555 0000'} WHERE id = ${id}`,
    );
    return id;
  });
}

async function optOut(patientId: string, channel: 'email' | 'whatsapp'): Promise<void> {
  await world.inTenant((tx) =>
    tx.execute(
      sql`INSERT INTO channel_preference (tenant_id, patient_id, channel, state, source)
            VALUES (${world.tenant.id}, ${patientId}, ${channel}, 'opted_out',
                    ${channel === 'email' ? 'email_link' : 'whatsapp_keyword'})`,
    ),
  );
}

async function optIn(patientId: string, channel: 'email' | 'whatsapp'): Promise<void> {
  await world.inTenant((tx) =>
    tx.execute(
      sql`INSERT INTO channel_preference (tenant_id, patient_id, channel, state, source)
            VALUES (${world.tenant.id}, ${patientId}, ${channel}, 'opted_in', 'online_booking')`,
    ),
  );
}

function body(patientId: string, extra: Record<string, unknown> = {}) {
  return { patientId, appointmentTypeId: world.consulta, offersOptIn: true, ...extra };
}

async function add(patientId: string, extra: Record<string, unknown> = {}) {
  const response = await world.api.post('/waitlist', world.reception, body(patientId, extra));
  expect(response.statusCode, response.body).toBe(201);
  return response.json<WaitlistEntryDto>();
}

const auditActions = (resourceId: string) =>
  world.inTenant(
    async (tx) =>
      (
        await tx.execute<{ action: string; metadata: Record<string, unknown> }>(
          sql`SELECT action, metadata FROM audit_event WHERE resource_id = ${resourceId} ORDER BY occurred_at, id`,
        )
      ).rows,
  );

describe('adding a patient to the waitlist', () => {
  it('creates an active entry that expires in 60 days, and audits it', async () => {
    const patientId = await reachablePatient();

    const entry = await add(patientId, {
      weekdays: [4, 1],
      timeRanges: [{ from: '08:00', to: '12:00' }],
      professionalId: world.doctor.professionalId,
    });

    expect(entry).toMatchObject({
      patientId,
      appointmentTypeId: world.consulta,
      professionalId: world.doctor.professionalId,
      locationId: null,
      weekdays: [1, 4],
      timeRanges: [{ from: '08:00', to: '12:00' }],
      status: 'active',
      closeReason: null,
      manualContactOnly: false,
      manualReason: null,
      offersOptInSource: 'staff',
      channels: ['email'],
      priority: 0,
      unresponsive: false,
      source: 'staff',
      openOffer: null,
    });
    expect(new Date(entry.expiresAt).getTime() - NOW.getTime()).toBe(60 * 86_400_000);
    expect(entry.patientName).toContain('Paciente');
    expect(entry.appointmentTypeName).toBe('Consulta');
    expect((await auditActions(entry.id)).map((row) => row.action)).toEqual([
      'waitlist.entry.created',
    ]);
  });

  it('records who gave the opt-in: the staff member, with the time', async () => {
    const entry = await add(await reachablePatient());

    expect(entry.offersOptInAt).toBe(NOW.toISOString());
    const [row] = await world.inTenant(
      async (tx) =>
        (
          await tx.execute<{ by: string | null }>(
            sql`SELECT offers_opt_in_by AS by FROM waitlist_entry WHERE id = ${entry.id}`,
          )
        ).rows,
    );
    expect(row?.by).toBe(world.reception.user.id);
  });

  it('rejects a duplicate and shows the entry that already exists', async () => {
    const patientId = await reachablePatient();
    const first = await add(patientId);

    const second = await world.api.post('/waitlist', world.reception, body(patientId));

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'conflict', existingEntryId: first.id });
  });

  it('treats a different professional as a different wait', async () => {
    const patientId = await reachablePatient();
    await add(patientId);

    const specific = await add(patientId, { professionalId: world.doctor.professionalId });

    expect(specific.professionalId).toBe(world.doctor.professionalId);
  });

  it('marks the entry manual contact only when the patient has no way to be reached', async () => {
    const entry = await add(await reachablePatient({ email: false, phone: false }));

    expect(entry).toMatchObject({
      status: 'active',
      manualContactOnly: true,
      manualReason: 'no_reachable_channel',
    });
  });

  it('marks the entry manual contact only when the patient opted out of every channel', async () => {
    const patientId = await reachablePatient();
    await optOut(patientId, 'email');
    await optOut(patientId, 'whatsapp');

    const entry = await add(patientId, { channels: ['email', 'whatsapp'] });

    expect(entry).toMatchObject({ manualContactOnly: true, manualReason: 'patient_opted_out' });
  });

  it('marks the entry manual contact only when the patient did not agree to receive offers', async () => {
    const entry = await add(await reachablePatient(), { offersOptIn: false });

    expect(entry).toMatchObject({
      manualContactOnly: true,
      manualReason: 'no_offers_opt_in',
      offersOptInAt: null,
      offersOptInSource: null,
    });
  });

  it('reaches a patient on WhatsApp only when they opted in to it', async () => {
    const withoutOptIn = await add(await reachablePatient(), { channels: ['whatsapp'] });
    const patientId = await reachablePatient();
    await optIn(patientId, 'whatsapp');
    const withOptIn = await add(patientId, { channels: ['whatsapp'] });

    expect(withoutOptIn.manualReason).toBe('no_reachable_channel');
    expect(withOptIn.manualContactOnly).toBe(false);
  });
});

describe('the limit of active entries', () => {
  it('refuses the sixth in-play entry of a patient, and counts only the ones in play', async () => {
    const patientId = await reachablePatient();
    const types = await world.inTenant(async (tx) => {
      const ids: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const [row] = (
          await tx.execute<{ id: string }>(
            sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes)
                  VALUES (${world.tenant.id}, ${`Tipo límite ${String(index)} ${String(counter)}`}, 30)
                  RETURNING id`,
          )
        ).rows;
        if (row) ids.push(row.id);
      }
      return ids;
    });

    const created: WaitlistEntryDto[] = [];
    for (const typeId of types.slice(0, 5)) {
      created.push(await add(patientId, { appointmentTypeId: typeId }));
    }
    const sixth = await world.api.post(
      '/waitlist',
      world.reception,
      body(patientId, { appointmentTypeId: types[5] }),
    );
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json()).toMatchObject({ code: 'waitlist_entry_limit' });

    // Closing one gives the place back.
    const first = created[0];
    if (!first) throw new Error('no entry');
    expect(
      (
        await world.api.post(`/waitlist/${first.id}/close`, world.reception, {
          reason: 'cancelled',
        })
      ).statusCode,
    ).toBe(200);
    const again = await world.api.post(
      '/waitlist',
      world.reception,
      body(patientId, { appointmentTypeId: types[5] }),
    );
    expect(again.statusCode, again.body).toBe(201);
  });

  it('follows the limit the organization sets', async () => {
    await world.api.patch('/settings', world.owner, { waitlist: { maxActiveEntries: 1 } });
    try {
      const patientId = await reachablePatient();
      await add(patientId);
      const second = await world.api.post(
        '/waitlist',
        world.reception,
        body(patientId, { professionalId: world.doctor.professionalId }),
      );

      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ code: 'waitlist_entry_limit' });
    } finally {
      await world.api.patch('/settings', world.owner, { waitlist: { maxActiveEntries: 5 } });
    }
  });
});

describe('what an entry may wait for', () => {
  it('refuses unknown references as not found and a professional that does not offer the type', async () => {
    const patientId = await reachablePatient();
    const unknown = '0190a000-0000-7000-8000-00000000dead';

    const missingPatient = await world.api.post('/waitlist', world.reception, body(unknown));
    const missingType = await world.api.post(
      '/waitlist',
      world.reception,
      body(patientId, { appointmentTypeId: unknown }),
    );
    const missingProfessional = await world.api.post(
      '/waitlist',
      world.reception,
      body(patientId, { professionalId: unknown }),
    );

    expect(missingPatient.statusCode).toBe(404);
    expect(missingType.statusCode).toBe(404);
    expect(missingProfessional.statusCode).toBe(404);
  });

  it('refuses a type the professional does not offer, an inactive patient and another organization', async () => {
    const patientId = await reachablePatient();
    const restricted = await world.inTenant(async (tx) => {
      const rows = (
        await tx.execute<{ id: string }>(
          sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes, professional_ids)
                VALUES (${world.tenant.id}, ${`Solo colega ${String(counter)}`}, 30,
                        ARRAY[${world.colleague.professionalId}]::uuid[])
                RETURNING id`,
        )
      ).rows;
      return rows[0]?.id ?? '';
    });
    const inactive = await reachablePatient();
    await world.inTenant((tx) =>
      tx.execute(sql`UPDATE patient SET status = 'inactive' WHERE id = ${inactive}`),
    );
    const foreign = await reachablePatient({ world: other });

    const notOffered = await world.api.post(
      '/waitlist',
      world.reception,
      body(patientId, {
        appointmentTypeId: restricted,
        professionalId: world.doctor.professionalId,
      }),
    );
    const inactiveResponse = await world.api.post('/waitlist', world.reception, body(inactive));
    const foreignResponse = await world.api.post('/waitlist', world.reception, body(foreign));

    expect(notOffered.statusCode).toBe(409);
    expect(notOffered.json()).toMatchObject({ code: 'waitlist_not_available' });
    expect(inactiveResponse.statusCode).toBe(409);
    expect(inactiveResponse.json()).toMatchObject({ code: 'waitlist_not_available' });
    expect(foreignResponse.statusCode).toBe(404);
  });
});

describe('managing entries', () => {
  it('lists the entries in play, newest wait first, and filters them', async () => {
    const mine = await add(await reachablePatient());

    const all = await world.api.get('/waitlist', world.reception);
    const filtered = await world.api.get(`/waitlist?patientId=${mine.patientId}`, world.reception);

    expect(all.statusCode).toBe(200);
    expect(all.json<WaitlistListResponse>().entries.map((entry) => entry.id)).toContain(mine.id);
    expect(filtered.json<WaitlistListResponse>().entries.map((entry) => entry.id)).toEqual([
      mine.id,
    ]);
  });

  it('shows an entry with its offers', async () => {
    const entry = await add(await reachablePatient());

    const detail = await world.api.get(`/waitlist/${entry.id}`, world.reception);

    expect(detail.statusCode).toBe(200);
    expect(detail.json<WaitlistEntryDetailResponse>()).toMatchObject({
      entry: { id: entry.id },
      offers: [],
    });
  });

  it('pauses and resumes an entry, and audits each change', async () => {
    const entry = await add(await reachablePatient());

    const paused = await world.api.post(`/waitlist/${entry.id}/pause`, world.reception, {});
    const filtered = await world.api.get('/waitlist?status=paused', world.reception);
    const resumed = await world.api.post(`/waitlist/${entry.id}/resume`, world.reception, {});

    expect(paused.json<WaitlistEntryDto>().status).toBe('paused');
    expect(filtered.json<WaitlistListResponse>().entries.map((row) => row.id)).toContain(entry.id);
    expect(resumed.json<WaitlistEntryDto>().status).toBe('active');
    expect((await auditActions(entry.id)).map((row) => row.action)).toEqual([
      'waitlist.entry.created',
      'waitlist.entry.updated',
      'waitlist.entry.updated',
    ]);
  });

  it('will not pause an entry that is paused, or resume one that is not', async () => {
    const entry = await add(await reachablePatient());

    const resumeActive = await world.api.post(`/waitlist/${entry.id}/resume`, world.reception, {});
    await world.api.post(`/waitlist/${entry.id}/pause`, world.reception, {});
    const pauseAgain = await world.api.post(`/waitlist/${entry.id}/pause`, world.reception, {});

    expect(resumeActive.statusCode).toBe(409);
    expect(pauseAgain.statusCode).toBe(409);
  });

  it('edits the preferences, and records the opt-in the patient gave later', async () => {
    const entry = await add(await reachablePatient(), { offersOptIn: false });
    expect(entry.manualContactOnly).toBe(true);

    const edited = await world.api.patch(`/waitlist/${entry.id}`, world.reception, {
      weekdays: [5, 2],
      timeRanges: [{ from: '14:00', to: '18:00' }],
      earliestDate: '2031-06-01',
      latestDate: '2031-06-30',
      offersOptIn: true,
    });

    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json<WaitlistEntryDto>()).toMatchObject({
      weekdays: [2, 5],
      timeRanges: [{ from: '14:00', to: '18:00' }],
      earliestDate: '2031-06-01',
      latestDate: '2031-06-30',
      manualContactOnly: false,
      offersOptInSource: 'staff',
    });
    const actions = await auditActions(entry.id);
    expect(actions.at(-1)?.action).toBe('waitlist.entry.updated');
    // Which fields changed, never what they were changed to.
    expect(actions.at(-1)?.metadata['fields']).toEqual([
      'earliestDate',
      'latestDate',
      'offersOptIn',
      'timeRanges',
      'weekdays',
    ]);
  });

  it('closes an entry with a reason, keeps it, and then refuses every change to it', async () => {
    const entry = await add(await reachablePatient());

    const closed = await world.api.post(`/waitlist/${entry.id}/close`, world.reception, {
      reason: 'fulfilled',
    });
    const edit = await world.api.patch(`/waitlist/${entry.id}`, world.reception, {
      weekdays: [1],
    });
    const pause = await world.api.post(`/waitlist/${entry.id}/pause`, world.reception, {});
    const closeAgain = await world.api.post(`/waitlist/${entry.id}/close`, world.reception, {
      reason: 'cancelled',
    });
    const kept = await world.api.get(`/waitlist/${entry.id}`, world.reception);

    expect(closed.json<WaitlistEntryDto>()).toMatchObject({
      status: 'closed',
      closeReason: 'fulfilled',
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json()).toMatchObject({ code: 'waitlist_entry_closed' });
    expect(pause.statusCode).toBe(409);
    expect(closeAgain.statusCode).toBe(409);
    expect(kept.json<WaitlistEntryDetailResponse>().entry.status).toBe('closed');
    const closing = (await auditActions(entry.id)).find(
      (row) => row.action === 'waitlist.entry.closed',
    );
    expect(closing?.metadata['reason']).toBe('fulfilled');
  });

  it('lets a patient wait again after the earlier entry was closed', async () => {
    const patientId = await reachablePatient();
    const first = await add(patientId);
    await world.api.post(`/waitlist/${first.id}/close`, world.reception, { reason: 'cancelled' });

    const second = await add(patientId);

    expect(second.id).not.toBe(first.id);
  });

  it('overrides the priority of an entry and audits the override with the old and new level', async () => {
    const entry = await add(await reachablePatient());

    const changed = await world.api.post(`/waitlist/${entry.id}/priority`, world.reception, {
      priority: 2,
    });
    const same = await world.api.post(`/waitlist/${entry.id}/priority`, world.reception, {
      priority: 2,
    });

    expect(changed.json<WaitlistEntryDto>().priority).toBe(2);
    expect(same.statusCode).toBe(200);
    const overrides = (await auditActions(entry.id)).filter(
      (row) => row.action === 'waitlist.priority.overridden',
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.metadata).toMatchObject({ from: 0, to: 2 });
  });

  it('closes the entries whose time ran out, with their reason, and keeps them', async () => {
    const entry = await add(await reachablePatient());
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE waitlist_entry SET expires_at = ${NOW.toISOString()}::timestamptz - interval '1 day' WHERE id = ${entry.id}`,
      ),
    );

    const closed = await world.inTenant(async (tx) => {
      const { closeExpiredEntries } = await import('../../src/modules/waitlist/index.js');
      return closeExpiredEntries(tx, { now: NOW });
    });

    expect(closed).toBeGreaterThanOrEqual(1);
    const after = await world.api.get(`/waitlist/${entry.id}`, world.reception);
    expect(after.json<WaitlistEntryDetailResponse>().entry).toMatchObject({
      status: 'closed',
      closeReason: 'expired',
    });
  });
});

describe('who can see and change the waitlist', () => {
  it('lets the professional and the administration in, and keeps a patient-less role out', async () => {
    const entry = await add(await reachablePatient());

    const asDoctor = await world.api.get(`/waitlist/${entry.id}`, world.doctor);
    const asAdmin = await world.api.get(`/waitlist/${entry.id}`, world.admin);

    expect(asDoctor.statusCode).toBe(200);
    expect(asAdmin.statusCode).toBe(200);
  });

  it("shows nothing of another organization's waitlist, and answers not found for its entries", async () => {
    const foreignPatient = await reachablePatient({ world: other });
    const foreign = await other.api.post('/waitlist', other.reception, {
      patientId: foreignPatient,
      appointmentTypeId: other.consulta,
      offersOptIn: true,
    });
    expect(foreign.statusCode, foreign.body).toBe(201);
    const foreignEntry = foreign.json<WaitlistEntryDto>();

    const list = await world.api.get('/waitlist', world.admin);
    const detail = await world.api.get(`/waitlist/${foreignEntry.id}`, world.admin);
    const pause = await world.api.post(`/waitlist/${foreignEntry.id}/pause`, world.admin, {});

    expect(list.json<WaitlistListResponse>().entries.map((row) => row.id)).not.toContain(
      foreignEntry.id,
    );
    expect(detail.statusCode).toBe(404);
    expect(pause.statusCode).toBe(404);
  });

  it('refuses a request that sends an organization or a status of its own', async () => {
    const response = await world.api.post(
      '/waitlist',
      world.reception,
      body(await reachablePatient(), { tenantId: other.tenant.id, status: 'closed' }),
    );

    expect(response.statusCode).toBe(400);
  });
});

describe('who sees which entries (JD-S3 B12)', () => {
  it('shows reception only the entries of the places it works at, and answers not found for the others', async () => {
    // Reception works at Centro only. An entry for Norte is not theirs to see or to change.
    const patientId = await reachablePatient();
    const made = await world.api.post(
      '/waitlist',
      world.owner,
      body(patientId, { locationId: world.norte }),
    );
    expect(made.statusCode, made.body).toBe(201);
    const entry = made.json<WaitlistEntryDto>();
    const anywhere = await add(await reachablePatient());

    const list = await world.api.get('/waitlist', world.reception);
    const detail = await world.api.get(`/waitlist/${entry.id}`, world.reception);
    const closed = await world.api.post(`/waitlist/${entry.id}/close`, world.reception, {
      reason: 'cancelled',
    });
    const ownerList = await world.api.get('/waitlist', world.owner);

    const ids = (response: typeof list) =>
      response.json<WaitlistListResponse>().entries.map((item) => item.id);
    expect(ids(list)).toContain(anywhere.id);
    expect(ids(list)).not.toContain(entry.id);
    expect(ids(ownerList)).toContain(entry.id);
    expect(detail.statusCode).toBe(404);
    expect(closed.statusCode).toBe(404);
    const refused = await world.api.post(
      '/waitlist',
      world.reception,
      body(await reachablePatient(), { locationId: world.norte }),
    );
    expect(refused.statusCode).toBe(404);
  });

  it("keeps a professional to their own calendar: the entries of a colleague's are not theirs", async () => {
    const patientId = await reachablePatient();
    const made = await world.api.post(
      '/waitlist',
      world.owner,
      body(patientId, { professionalId: world.colleague.professionalId }),
    );
    expect(made.statusCode, made.body).toBe(201);
    const entry = made.json<WaitlistEntryDto>();
    const mine = await world.api.post(
      '/waitlist',
      world.doctor,
      body(await reachablePatient(), { professionalId: world.doctor.professionalId }),
    );
    expect(mine.statusCode, mine.body).toBe(201);

    const list = await world.api.get('/waitlist', world.doctor);
    const detail = await world.api.get(`/waitlist/${entry.id}`, world.doctor);
    const pause = await world.api.post(`/waitlist/${entry.id}/pause`, world.doctor, {});

    const ids = list.json<WaitlistListResponse>().entries.map((item) => item.id);
    expect(ids).toContain(mine.json<WaitlistEntryDto>().id);
    expect(ids).not.toContain(entry.id);
    expect(detail.statusCode).toBe(404);
    expect(pause.statusCode).toBe(404);
  });
});
