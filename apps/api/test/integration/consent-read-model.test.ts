import type { ConsentListResponse } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { consentStateFor, hasValidConsent } from '../../src/modules/consent/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  insertConsentRequest,
  insertConsentRevocation,
  insertConsentSignature,
} from '../support/consent-rows.js';
import { createDocumentsHarness, type DocumentsHarness } from '../support/documents.js';
import { asTenant } from '../support/tenants.js';

/**
 * The consents of a patient as each viewer sees them (S5.02, task 5.10; informed-consent,
 * "Visibility and access control"): a treating professional sees the title; reception sees status
 * and dates under the neutral label, and the title only when the organization turned on "reception
 * sees clinical metadata"; the administration never sees a title; nobody non-clinical sees content.
 */
let runtime: DbHandle;
let h: DocumentsHarness;

const TITLE = 'Extracción de muela del juicio';
const BODY = 'Autorizo la extracción de la muela del juicio inferior izquierda.';

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  h = await createDocumentsHarness(runtime, 'consent-read-model');
});

afterAll(async () => {
  await h.close();
  await runtime.close();
});

const setSettings = (settings: Record<string, unknown>) =>
  asTenant(runtime, h.tenant.id, (tx) =>
    tx.update(tenantTable).set({ settings }).where(eq(tenantTable.id, h.tenant.id)),
  );

/** A published template whose version carries a recognizable title and text. */
async function templateVersion(tx: Parameters<Parameters<typeof asTenant>[2]>[0]) {
  const template = (
    await tx.execute<{ id: string }>(
      sql`INSERT INTO consent_template (tenant_id, title, draft_body, status, created_by)
            VALUES (${h.tenant.id}, ${TITLE}, ${BODY}, 'published', gen_random_uuid())
            RETURNING id`,
    )
  ).rows[0]?.id;
  const version = (
    await tx.execute<{ id: string }>(
      sql`INSERT INTO consent_template_version
            (tenant_id, template_id, version_number, title, body, content_hash, published_by)
            VALUES (${h.tenant.id}, ${template}, 1, ${TITLE}, ${BODY}, ${'a'.repeat(64)}, gen_random_uuid())
            RETURNING id`,
    )
  ).rows[0]?.id;
  if (!template || !version) throw new Error('could not seed the template');
  return { templateId: template, versionId: version };
}

type SeedState = 'pending' | 'signed' | 'revoked' | 'declined';

async function seedConsent(patientId: string, state: SeedState) {
  return asTenant(runtime, h.tenant.id, async (tx) => {
    const { templateId, versionId } = await templateVersion(tx);
    const requestId = await insertConsentRequest(tx, h.tenant.id, {
      patient_id: patientId,
      template_version_id: versionId,
    });
    if (state === 'signed' || state === 'revoked') {
      await insertConsentSignature(tx, h.tenant.id, {
        request_id: requestId,
        patient_id: patientId,
        template_version_id: versionId,
      });
    }
    if (state === 'revoked') {
      await insertConsentRevocation(tx, h.tenant.id, {
        request_id: requestId,
        patient_id: patientId,
      });
    }
    if (state === 'declined') {
      await tx.execute(
        sql`UPDATE consent_request SET status = 'declined', closed_at = now() WHERE id = ${requestId}`,
      );
    }
    return { requestId, templateId, versionId };
  });
}

const list = async (patientId: string, session: typeof h.sessions.reception) => {
  const response = await h.api.get(`/patients/${patientId}/consents`, session);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ConsentListResponse>().consents;
};

describe('a treating professional', () => {
  it('sees every consent of the patient, with its title and the signed record to open', async () => {
    const patientId = await h.patient();
    const signed = await seedConsent(patientId, 'signed');
    const pending = await seedConsent(patientId, 'pending');

    const consents = await list(patientId, h.sessions.professional);

    expect(consents.map((entry) => entry.id).sort()).toEqual(
      [signed.requestId, pending.requestId].sort(),
    );
    const mine = consents.find((entry) => entry.id === signed.requestId);
    expect(mine).toMatchObject({ status: 'signed', title: TITLE, versionNumber: 1, canOpen: true });
    expect(mine?.signedAt).not.toBeNull();
    // Nothing to open while nobody has signed.
    expect(consents.find((entry) => entry.id === pending.requestId)).toMatchObject({
      status: 'pending',
      title: TITLE,
      canOpen: false,
    });
  });

  it('shows a revoked consent as revoked, with its date, and still lets the record be opened', async () => {
    const patientId = await h.patient();
    const revoked = await seedConsent(patientId, 'revoked');

    const [entry] = await list(patientId, h.sessions.professional);

    expect(entry).toMatchObject({ id: revoked.requestId, status: 'revoked', canOpen: true });
    expect(entry?.revokedAt).not.toBeNull();
    expect(entry?.signedAt).not.toBeNull();
  });

  it('shows a request past its date as expired, even before the job records it', async () => {
    const patientId = await h.patient();
    const requestId = await asTenant(runtime, h.tenant.id, async (tx) => {
      const { versionId } = await templateVersion(tx);
      return insertConsentRequest(
        tx,
        h.tenant.id,
        { patient_id: patientId, template_version_id: versionId },
        { expiresAt: new Date(Date.now() - 60_000) },
      );
    });

    const [entry] = await list(patientId, h.sessions.professional);

    expect(entry).toMatchObject({ id: requestId, status: 'expired', canOpen: false });
  });
});

describe('reception', () => {
  it('sees status and dates under the neutral label when the setting is off, and never the content', async () => {
    await setSettings({});
    const patientId = await h.patient();
    const signed = await seedConsent(patientId, 'signed');

    const response = await h.api.get(`/patients/${patientId}/consents`, h.sessions.reception);
    const [entry] = response.json<ConsentListResponse>().consents;

    expect(entry).toMatchObject({
      id: signed.requestId,
      status: 'signed',
      title: null,
      versionNumber: null,
      canOpen: false,
    });
    expect(entry?.signedAt).not.toBeNull();
    expect(response.body).not.toContain('muela');
    expect(response.body).not.toContain(BODY);
  });

  it('sees the title as well when the organization allows it, and still cannot open the signed record', async () => {
    await setSettings({ reception_sees_clinical_metadata: true });
    try {
      const patientId = await h.patient();
      await seedConsent(patientId, 'signed');

      const response = await h.api.get(`/patients/${patientId}/consents`, h.sessions.reception);
      const [entry] = response.json<ConsentListResponse>().consents;

      expect(entry).toMatchObject({ title: TITLE, status: 'signed', canOpen: false });
      expect(response.body).not.toContain(BODY);
    } finally {
      await setSettings({});
    }
  });
});

describe('the administration', () => {
  it('never sees a title, with the setting on or off', async () => {
    const patientId = await h.patient();
    await seedConsent(patientId, 'revoked');

    for (const settings of [{}, { reception_sees_clinical_metadata: true }]) {
      await setSettings(settings);
      for (const session of [h.sessions.admin, h.sessions.owner]) {
        const response = await h.api.get(`/patients/${patientId}/consents`, session);
        const [entry] = response.json<ConsentListResponse>().consents;
        expect(entry).toMatchObject({ status: 'revoked', title: null, canOpen: false });
        expect(response.body).not.toContain('muela');
      }
    }
    await setSettings({});
  });
});

describe('a professional who does not treat the patient', () => {
  it('sees the status and dates only, until the organization shares clinical content', async () => {
    const patientId = await h.patient({ treatedBy: 'nobody' });
    await seedConsent(patientId, 'signed');

    const [apart] = await list(patientId, h.sessions.colleague);
    expect(apart).toMatchObject({ status: 'signed', title: null, canOpen: false });

    await setSettings({ clinicalSharing: true, sharedTemplates: ['general'] });
    try {
      const [shared] = await list(patientId, h.sessions.colleague);
      expect(shared).toMatchObject({ status: 'signed', title: TITLE, canOpen: true });
    } finally {
      await setSettings({});
    }
  });
});

describe('another patient', () => {
  it('lists only the consents of the patient asked for', async () => {
    const mine = await h.patient();
    const theirs = await h.patient();
    const own = await seedConsent(mine, 'signed');
    await seedConsent(theirs, 'signed');

    const consents = await list(mine, h.sessions.professional);

    expect(consents.map((entry) => entry.id)).toEqual([own.requestId]);
  });

  it('answers as if the patient did not exist for a patient of another organization', async () => {
    const response = await h.api.get(
      '/patients/0197c0a0-0000-7000-8000-0000000000aa/consents',
      h.sessions.professional,
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('hasValidConsent', () => {
  it('is true only for a signed consent of that template, and false once it is revoked', async () => {
    const patientId = await h.patient();
    const signed = await seedConsent(patientId, 'signed');
    const revoked = await seedConsent(await h.patient(), 'revoked');
    const pending = await seedConsent(await h.patient(), 'pending');
    const check = (patient: string, template: string) =>
      asTenant(runtime, h.tenant.id, async (tx) => ({
        valid: await hasValidConsent(tx, patient, template),
        state: await consentStateFor(tx, patient, template),
      }));

    expect(await check(patientId, signed.templateId)).toEqual({ valid: true, state: 'valid' });
    expect(await check(patientId, revoked.templateId)).toEqual({ valid: false, state: 'none' });
    const afterRevocation = await asTenant(runtime, h.tenant.id, async (tx) => {
      const row = await tx.execute<{ patient_id: string }>(
        sql`SELECT patient_id FROM consent_request WHERE id = ${revoked.requestId}`,
      );
      return consentStateFor(tx, row.rows[0]?.patient_id ?? '', revoked.templateId);
    });
    expect(afterRevocation).toBe('revoked');
    const waiting = await asTenant(runtime, h.tenant.id, async (tx) => {
      const row = await tx.execute<{ patient_id: string }>(
        sql`SELECT patient_id FROM consent_request WHERE id = ${pending.requestId}`,
      );
      return hasValidConsent(tx, row.rows[0]?.patient_id ?? '', pending.templateId);
    });
    expect(waiting).toBe(false);
  });
});
