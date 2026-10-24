import type {
  PortalConsentResponse,
  PortalConsentsResponse,
  PortalMeResponse,
  PortalPrescriptionsResponse,
  PortalProfileResponse,
  PortalRequestResponse,
  Problem,
  RightsRequestListResponse,
} from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createFakePortalConsents,
  createFakePortalPrescriptions,
  type FakePortalConsents,
  type FakePortalPrescriptions,
} from '../support/portal-fakes.js';
import { createPortalWorld, rowsOf, type PortalWorld } from '../support/portal-world.js';

/** The fingerprint the fake port shows for the text of every consent. */
const HASH = 'f'.repeat(64);

/**
 * The sections of the portal that read other modules and the patient's own data (S5.08, tasks 5.33
 * and 5.34). Consents and prescriptions come from the modules of other tracks: here they are fakes
 * that behave the way the ports promise.
 */
let runtime: DbHandle;
let plain: PortalWorld;
let world: PortalWorld;
let consents: FakePortalConsents;
let prescriptions: FakePortalPrescriptions;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  consents = createFakePortalConsents();
  prescriptions = createFakePortalPrescriptions();
  // No consent or prescription module behind the portal: the sections are empty states.
  plain = await createPortalWorld(runtime, { slug: 'portal-sections-plain', ports: {} });
  world = await createPortalWorld(runtime, {
    slug: 'portal-sections',
    ports: { consent: consents, prescriptions },
  });
});

afterAll(async () => {
  await plain.close();
  await world.close();
  await runtime.close();
});

const audits = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action as never)))
      .orderBy(asc(auditEvent.occurredAt)),
  );

const setStatus = (status: 'active' | 'read_only') =>
  world.inTenant((tx) =>
    tx.execute(
      status === 'read_only'
        ? sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${world.tenant.id}`
        : sql`UPDATE tenant SET status = 'active', read_only_since = NULL WHERE id = ${world.tenant.id}`,
    ),
  );

describe('consents', () => {
  it('are an empty state while no module serves them, and the sign and revoke routes find nothing', async () => {
    const { visitor } = await plain.patientSession();

    const listed = await visitor.get('/portal/consents');
    const me = (await visitor.get('/portal/me')).json<PortalMeResponse>();

    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<PortalConsentsResponse>()).toEqual({ available: false, consents: [] });
    expect(me.capabilities).toEqual({ consents: false, prescriptions: false });
    const id = '0190a000-0000-7000-8000-00000000dead';
    expect((await visitor.get(`/portal/consents/${id}`)).statusCode).toBe(404);
    expect(
      (
        await visitor.post(`/portal/consents/${id}/sign`, {
          accepted: true,
          contentHash: HASH,
          signerName: 'Ana Pérez',
          signature: { kind: 'typed', value: 'Ana Pérez' },
        })
      ).statusCode,
    ).toBe(404);
    expect((await visitor.post(`/portal/consents/${id}/revoke`, {})).statusCode).toBe(404);
  });

  it('are listed by the module for the patient of the session, and only theirs', async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const own = consents.seed(mine.patientId, { title: 'Consentimiento propio' });
    consents.seed(theirs.patientId, { title: 'Consentimiento ajeno' });

    const response = await mine.visitor.get('/portal/consents');

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<PortalConsentsResponse>();
    expect(body.available).toBe(true);
    expect(body.consents.map((consent) => [consent.id, consent.title, consent.status])).toEqual([
      [own, 'Consentimiento propio', 'pending'],
    ]);
    // The port was asked for the patient of the session and nobody else.
    const listCalls = consents.calls.filter(
      (call) => call.method === 'list' && call.identityId === mine.identity.id,
    );
    expect(listCalls.every((call) => call.patientId === mine.patientId)).toBe(true);
    expect(listCalls.length).toBeGreaterThan(0);
    expect((await mine.visitor.get('/portal/me')).json<PortalMeResponse>().capabilities).toEqual({
      consents: true,
      prescriptions: true,
    });
  });

  it("show the full text to sign, and answer 404 and audit for one that is not the patient's", async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const own = consents.seed(mine.patientId, { body: 'El texto completo.' });
    const foreign = consents.seed(theirs.patientId);
    const before = (await audits('portal.denied')).length;

    const detail = await mine.visitor.get(`/portal/consents/${own}`);
    const refused = await mine.visitor.get(`/portal/consents/${foreign}`);

    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ id: own, body: 'El texto completo.', canSign: true });
    expect(refused.statusCode).toBe(404);
    const rows = (await audits('portal.denied')).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resourceType: 'consent',
      resourceId: foreign,
      patientId: mine.patientId,
    });
  });

  it('are signed with the explicit acceptance, and a signature without it is refused before the module', async () => {
    const { visitor, patientId } = await world.patientSession();
    const id = consents.seed(patientId);
    const callsBefore = consents.calls.length;

    const without = await visitor.post(`/portal/consents/${id}/sign`, {
      contentHash: HASH,
      signerName: 'Ana Pérez',
      signature: { kind: 'typed', value: 'Ana Pérez' },
    });
    const unticked = await visitor.post(`/portal/consents/${id}/sign`, {
      accepted: false,
      contentHash: HASH,
      signerName: 'Ana Pérez',
      signature: { kind: 'typed', value: 'Ana Pérez' },
    });
    expect(without.statusCode).toBe(400);
    expect(unticked.statusCode).toBe(400);
    expect(consents.calls.length).toBe(callsBefore);

    const signed = await visitor.post(`/portal/consents/${id}/sign`, {
      accepted: true,
      contentHash: HASH,
      signerName: 'Ana Pérez',
      signature: { kind: 'typed', value: 'Ana Pérez' },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json<PortalConsentResponse>().consent).toMatchObject({
      id,
      status: 'signed',
      canSign: false,
      canRevoke: true,
      hasDocument: true,
    });
    expect(consents.recordOf(id)?.signedWith?.signerName).toBe('Ana Pérez');
    // Signing twice is the module's conflict.
    expect(
      (
        await visitor.post(`/portal/consents/${id}/sign`, {
          accepted: true,
          contentHash: HASH,
          signerName: 'Ana Pérez',
          signature: { kind: 'typed', value: 'Ana Pérez' },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('are signed for a dependent with the data of the representative, and not without it', async () => {
    const parentEmail = `rep-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const child = await world.patientWith({ birthDate: '2020-09-14', email: null });
    await world.inviteOk(child, {
      email: parentEmail,
      relation: 'mother',
      verificationNote: 'Verificado en persona con la partida de nacimiento.',
    });
    await world.activate(world.activationPathSentTo(parentEmail));
    const visitor = await world.signInAs(parentEmail);
    const id = consents.seed(child);
    const sign = (extra: Record<string, unknown>) =>
      visitor.post(`/portal/consents/${id}/sign`, {
        accepted: true,
        contentHash: HASH,
        signerName: 'María Gómez',
        signature: { kind: 'typed', value: 'María Gómez' },
        ...extra,
      });

    expect((await sign({})).statusCode).toBe(400);
    const done = await sign({
      representative: { fullName: 'María Gómez', nationalId: '30111222', relation: 'mother' },
    });

    expect(done.statusCode, done.body).toBe(200);
    expect(consents.recordOf(id)?.signedWith?.representative).toMatchObject({ relation: 'mother' });
  });

  it('are revoked by the patient, and the revocation stays open in a read-only organization while signing does not', async () => {
    const { visitor, patientId } = await world.patientSession();
    const signedId = consents.seed(patientId, { status: 'signed' });
    const pendingId = consents.seed(patientId);
    await setStatus('read_only');
    try {
      const sign = await visitor.post(`/portal/consents/${pendingId}/sign`, {
        accepted: true,
        contentHash: HASH,
        signerName: 'Ana Pérez',
        signature: { kind: 'typed', value: 'Ana Pérez' },
      });
      const revoke = await visitor.post(`/portal/consents/${signedId}/revoke`, {
        reason: 'Ya no estoy de acuerdo',
      });
      const list = await visitor.get('/portal/consents');

      expect(sign.statusCode).toBe(402);
      expect(sign.json<Problem>().code).toBe('tenant_read_only');
      expect(revoke.statusCode, revoke.body).toBe(200);
      expect(revoke.json<PortalConsentResponse>().consent).toMatchObject({ status: 'revoked' });
      expect(list.statusCode).toBe(200);
    } finally {
      await setStatus('active');
    }
    expect(consents.recordOf(signedId)?.revokedBecause).toBe('Ya no estoy de acuerdo');
  });

  it('cannot be revoked by somebody else: 404, and the consent stays as it was', async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const foreign = consents.seed(theirs.patientId, { status: 'signed' });

    const response = await mine.visitor.post(`/portal/consents/${foreign}/revoke`, {});

    expect(response.statusCode).toBe(404);
    expect(consents.recordOf(foreign)?.status).toBe('signed');
  });
});

describe('prescriptions', () => {
  it('are an empty state while no module serves them', async () => {
    const { visitor } = await plain.patientSession();

    const response = await visitor.get('/portal/prescriptions');

    expect(response.json<PortalPrescriptionsResponse>()).toEqual({
      available: false,
      prescriptions: [],
      nextCursor: null,
    });
  });

  it('are listed by the module for the patient of the session without their medications', async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const own = prescriptions.seed(mine.patientId, { prescriberName: 'Dra. Propia' });
    prescriptions.seed(theirs.patientId, { prescriberName: 'Dr. Ajeno' });

    const response = await mine.visitor.get('/portal/prescriptions');

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<PortalPrescriptionsResponse>();
    expect(body.available).toBe(true);
    expect(body.prescriptions.map((p) => [p.id, p.prescriberName, p.status])).toEqual([
      [own, 'Dra. Propia', 'issued'],
    ]);
    expect(Object.keys(body.prescriptions[0] ?? {}).sort()).toEqual([
      'hasDocument',
      'id',
      'issuedAt',
      'prescriberName',
      'status',
    ]);
    const rows = (await audits('portal.read')).filter((row) => row.patientId === mine.patientId);
    expect(rows.at(-1)?.metadata).toMatchObject({ section: 'prescription', count: 1 });
  });
});

describe("the patient's own data", () => {
  it('shows the demographics, the contact data, the consent status and what was asked', async () => {
    const { visitor, patientId } = await world.patientSession({
      patient: { phone: '+54 11 5555 1111', address: 'Calle 1 123' },
    });

    const response = await visitor.get('/portal/profile');

    expect(response.statusCode, response.body).toBe(200);
    const profile = response.json<PortalProfileResponse>();
    expect(profile).toMatchObject({
      phone: '+54 11 5555 1111',
      address: 'Calle 1 123',
      version: 1,
      dataProcessing: { granted: false, grantedAt: null },
      requests: [],
    });
    expect(profile.document?.type).toBe('dni');
    expect(JSON.stringify(profile)).not.toContain(patientId);
  });

  it('changes the phone as a new version, with the previous state kept and the fields audited', async () => {
    const { visitor, patientId } = await world.patientSession({
      patient: { phone: '+54 11 5555 1111' },
    });

    const response = await visitor.patch('/portal/profile', {
      phone: '+54 11 5555 2222',
      expectedVersion: 1,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PortalProfileResponse>()).toMatchObject({
      phone: '+54 11 5555 2222',
      version: 2,
    });
    const versions = await rowsOf<{
      version: number;
      snapshot: { phone: string };
      changed_fields: string[];
    }>(
      world,
      sql`SELECT version, snapshot, changed_fields FROM patient_version WHERE patient_id = ${patientId} ORDER BY version`,
    );
    expect(versions.map((v) => v.version)).toContain(2);
    expect(versions.find((v) => v.version === 2)).toMatchObject({
      snapshot: { phone: '+54 11 5555 2222' },
      changed_fields: ['phone'],
    });
    const rows = (await audits('portal.profile.changed')).filter(
      (row) => row.patientId === patientId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actingRole: 'patient', actorUserId: null });
    expect(rows[0]?.metadata).toMatchObject({
      fields: ['phone'],
      versionBefore: 1,
      versionAfter: 2,
    });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('5555');
  });

  it('refuses a stale form, and says nothing changed when nothing did', async () => {
    const { visitor, patientId } = await world.patientSession({
      patient: { phone: '+54 11 5555 1111' },
    });
    await visitor.patch('/portal/profile', { phone: '+54 11 5555 3333', expectedVersion: 1 });

    const stale = await visitor.patch('/portal/profile', {
      phone: '+54 11 5555 4444',
      expectedVersion: 1,
    });
    const same = await visitor.patch('/portal/profile', { phone: '+54 11 5555 3333' });

    expect(stale.statusCode).toBe(409);
    expect(same.statusCode).toBe(200);
    expect(same.json<PortalProfileResponse>().version).toBe(2);
    const rows = (await audits('portal.profile.changed')).filter(
      (row) => row.patientId === patientId,
    );
    expect(rows).toHaveLength(1);
  });

  it('does not let the patient change a name, a document or a birth date, or a record of somebody else', async () => {
    const mine = await world.patientSession({ patient: { familyName: 'Original' } });
    const theirs = await world.patientSession();

    const identity = await mine.visitor.patch('/portal/profile', { familyName: 'Otro' });
    const elsewhere = await mine.visitor.patch('/portal/profile', {
      phone: '+54 11 5555 0000',
      patientId: theirs.patientId,
    });

    expect(identity.statusCode).toBe(400);
    expect(elsewhere.statusCode).toBe(400);
    const [row] = await rowsOf<{ family_name: string }>(
      world,
      sql`SELECT family_name FROM patient WHERE id = ${mine.patientId}`,
    );
    expect(row?.family_name).toBe('Original');
  });

  it('turns the correction of an identity field into a request that stays open and leaves the record as it was', async () => {
    const { visitor, patientId } = await world.patientSession({
      patient: { familyName: 'Perrez' },
    });
    world.email.clear();

    const response = await visitor.post('/portal/rectification-requests', {
      field: 'familyName',
      correctValue: 'Pérez',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PortalRequestResponse>().request).toMatchObject({
      kind: 'rectification',
      status: 'open',
    });
    const [row] = await rowsOf<{ family_name: string; version: number }>(
      world,
      sql`SELECT family_name, version FROM patient WHERE id = ${patientId}`,
    );
    expect(row).toEqual({ family_name: 'Perrez', version: 1 });
    // Staff see it as pending on the patient, with what was asked.
    const staff = await world.api.get(`/patients/${patientId}/rights-requests`, world.reception);
    expect(staff.json<RightsRequestListResponse>().requests[0]).toMatchObject({
      kind: 'rectification',
      status: 'open',
      note: 'Apellido: Pérez',
    });
    const profile = (await visitor.get('/portal/profile')).json<PortalProfileResponse>();
    expect(profile.requests).toHaveLength(1);
  });

  it('asks the organization for a copy of the clinical history and tells it by email without the detail', async () => {
    const { visitor, patientId } = await world.patientSession();
    world.email.clear();

    const response = await visitor.post('/portal/copy-requests', {
      note: 'Para llevar a otro médico',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PortalRequestResponse>().request).toMatchObject({
      kind: 'access',
      status: 'open',
    });
    const notices = world.email.sent.filter((mail) => mail.subject.includes('Nueva solicitud'));
    expect(notices.length).toBeGreaterThanOrEqual(1);
    for (const notice of notices) {
      expect(notice.text).toContain('copia de su historia clínica');
      expect(notice.text).toContain(`/patients/${patientId}`);
      expect(notice.text).not.toContain('otro médico');
      expect(notice.html).not.toContain('otro médico');
    }
    const staff = await world.api.get(`/patients/${patientId}/rights-requests`, world.reception);
    expect(staff.json<RightsRequestListResponse>().requests[0]).toMatchObject({
      kind: 'access',
      note: 'Para llevar a otro médico',
    });
  });

  it('keeps the requests of the patient open in a read-only organization and blocks the change of the contact data', async () => {
    const { visitor } = await world.patientSession();
    await setStatus('read_only');
    try {
      const change = await visitor.patch('/portal/profile', { phone: '+54 11 5555 9999' });
      const copy = await visitor.post('/portal/copy-requests', {});
      const fix = await visitor.post('/portal/rectification-requests', {
        field: 'givenNames',
        correctValue: 'Ana',
      });
      const read = await visitor.get('/portal/profile');

      expect(change.statusCode).toBe(402);
      expect(copy.statusCode, copy.body).toBe(200);
      expect(fix.statusCode, fix.body).toBe(200);
      expect(read.statusCode).toBe(200);
    } finally {
      await setStatus('active');
    }
  });

  it('lets a representative change the contact data of the dependent they represent', async () => {
    const parentEmail = `padre-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const child = await world.patientWith({
      birthDate: '2021-01-01',
      email: null,
      phone: '+54 11 1',
    });
    await world.inviteOk(child, {
      email: parentEmail,
      relation: 'father',
      verificationNote: 'Verificado en persona con la partida de nacimiento.',
    });
    await world.activate(world.activationPathSentTo(parentEmail));
    const visitor = await world.signInAs(parentEmail);

    const response = await visitor.patch('/portal/profile', { phone: '+54 11 5555 7777' });

    expect(response.statusCode, response.body).toBe(200);
    const [row] = await rowsOf<{ phone: string }>(
      world,
      sql`SELECT phone FROM patient WHERE id = ${child}`,
    );
    expect(row?.phone).toBe('+54 11 5555 7777');
  });
});

describe('the clinical record', () => {
  it('adds nothing to any section of the portal', async () => {
    const { visitor, patientId } = await world.patientSession();
    const sections = [
      '/portal/me',
      '/portal/appointments',
      '/portal/documents',
      '/portal/invoices',
      '/portal/consents',
      '/portal/prescriptions',
      '/portal/profile',
    ];
    const read = async () => {
      const bodies: Record<string, string> = {};
      for (const section of sections) {
        const response = await visitor.get(section);
        expect(response.statusCode, section).toBe(200);
        bodies[section] = response.body.replaceAll(/"requestId":"[^"]+"/g, '');
      }
      return bodies;
    };
    const before = await read();

    // A signed encounter with a note, a clinical document nobody shared, and an internal note.
    await world.inTenant(async (tx) => {
      await tx.execute(
        sql`select set_config('app.professional_id', ${world.doctor.professionalId}, true)`,
      );
      const encounter = await tx.execute<{ id: string }>(
        sql`INSERT INTO encounter (tenant_id, patient_id, author_professional_id, template_kind)
              VALUES (${world.tenant.id}, ${patientId}, ${world.doctor.professionalId}, 'general')
              RETURNING id`,
      );
      const note = await tx.execute<{ id: string }>(
        sql`INSERT INTO clinical_note (tenant_id, encounter_id, patient_id, author_professional_id, template_kind, template_version)
              VALUES (${world.tenant.id}, ${encounter.rows[0]?.id ?? ''}, ${patientId}, ${world.doctor.professionalId}, 'general', 1)
              RETURNING id`,
      );
      await tx.execute(
        sql`INSERT INTO note_version (tenant_id, note_id, patient_id, author_professional_id, visibility,
                                      template_kind, template_version, version_no, content_enc, content_hash)
              VALUES (${world.tenant.id}, ${note.rows[0]?.id ?? ''}, ${patientId}, ${world.doctor.professionalId},
                      'default', 'general', 1, 1, ${Buffer.from([1, 2, 3])}, ${'b'.repeat(64)})`,
      );
    });
    await world.documentFor(patientId, { clinical: true, name: 'diagnostico-confidencial.pdf' });
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE patient SET admin_notes = 'NOTA-INTERNA-DE-RECEPCION' WHERE id = ${patientId}`,
      ),
    );
    const after = await read();

    // Nothing the clinical record or the internal notes hold shows anywhere, and nothing changed,
    // apart from the version of the record the administrative note moved.
    for (const section of sections) {
      expect(after[section], section).not.toContain('diagnostico');
      expect(after[section], section).not.toContain('NOTA-INTERNA');
    }
    for (const section of sections.filter((entry) => entry !== '/portal/profile')) {
      expect(after[section], section).toBe(before[section]);
    }
  });
});
