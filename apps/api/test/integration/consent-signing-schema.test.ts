import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, type Tx } from '../../src/platform/db/tenant-context.js';
import {
  insertConsentRequest,
  insertConsentRevocation,
  insertConsentSignature,
  insertConsentTemplateVersion,
  readRequest,
} from '../support/consent-rows.js';
import { insertPatient, insertProfessional } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant, TEST_USER, type TestTenant } from '../support/tenants.js';

/**
 * Requests, signatures and revocations as the database enforces them (informed-consent,
 * "Signature capture and binding", "Immutability of signed consents" and "Revocation"). The state
 * of a request follows the rows beside it and is kept by triggers; a signature and a revocation
 * never change for any role.
 */
let runtime: DbHandle;
let owner: pg.Client;
let a: TestTenant;

const IMMUTABLE = '23000';
const NOT_ALLOWED = '42501';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const MISSING_PARENT = '23503';

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  a = await createTestTenant(runtime, { slug: 'consent-signing-schema' });
});

afterAll(async () => {
  await owner.end();
  await runtime.close();
});

const refusal = (tx: Tx, work: (inner: Tx) => Promise<unknown>) =>
  tx.transaction(work).then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

/** A statement as the migration owner, in the tenant, in a transaction that is rolled back. */
async function asOwner(
  statements: readonly string[],
  settings: Readonly<Record<string, string>> = {},
): Promise<(string | undefined)[]> {
  await owner.query('BEGIN');
  try {
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.id]);
    for (const [name, value] of Object.entries(settings)) {
      await owner.query(`SELECT set_config($1, $2, true)`, [name, value]);
    }
    const codes: (string | undefined)[] = [];
    for (const statement of statements) {
      await owner.query('SAVEPOINT attempt');
      try {
        await owner.query(statement);
        codes.push(undefined);
      } catch (error) {
        codes.push((error as { code?: string }).code);
        await owner.query('ROLLBACK TO attempt');
      }
    }
    return codes;
  } finally {
    await owner.query('ROLLBACK');
  }
}

/** Runs as a health professional (the clinical policies need one). */
const asProfessional = <T>(professionalId: string, fn: (tx: Tx) => Promise<T>) =>
  createWithTenant(runtime.db)(
    { tenantId: a.id, userId: TEST_USER, actingProfessionalId: professionalId },
    fn,
  );

describe('consent_request', () => {
  it('starts pending, with the version it was made for and an expiry', async () => {
    const row = await asTenant(runtime, a.id, async (tx) =>
      readRequest(tx, await insertConsentRequest(tx, a.id)),
    );

    expect(row).toMatchObject({
      status: 'pending',
      method: 'in_person',
      signed_at: null,
      revoked_at: null,
      closed_at: null,
    });
  });

  it('is always made pending: it cannot be born signed, revoked or closed', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const patientId = await insertPatient(tx, a.id);
      const versionId = await insertConsentTemplateVersion(tx, a.id);
      const insertAs = (status: string, extra: ReturnType<typeof sql>) =>
        refusal(tx, (inner) =>
          inner.execute(
            sql`INSERT INTO consent_request
                  (tenant_id, patient_id, template_version_id, status, method, expires_at,
                   requested_by, signed_at, closed_at)
                  VALUES (${a.id}, ${patientId}, ${versionId}, ${status}, 'in_person',
                          now() + interval '1 day', gen_random_uuid(), ${extra}, ${extra})`,
          ),
        );
      return [
        await insertAs('signed', sql`now()`),
        await insertAs('declined', sql`now()`),
        await insertAs('pending', sql`null`),
      ];
    });

    expect(codes).toEqual([IMMUTABLE, IMMUTABLE, undefined]);
  });

  it('refuses a method that is not in the catalog, and a state it cannot start in', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const patientId = await insertPatient(tx, a.id);
      const versionId = await insertConsentTemplateVersion(tx, a.id);
      return [
        await refusal(tx, (inner) =>
          inner.execute(
            sql`INSERT INTO consent_request
                  (tenant_id, patient_id, template_version_id, method, expires_at, requested_by)
                  VALUES (${a.id}, ${patientId}, ${versionId}, 'phone', now() + interval '1 day',
                          gen_random_uuid())`,
          ),
        ),
        await refusal(tx, (inner) =>
          inner.execute(
            sql`INSERT INTO consent_request
                  (tenant_id, patient_id, template_version_id, status, method, expires_at, requested_by)
                  VALUES (${a.id}, ${patientId}, ${versionId}, 'archived', 'portal',
                          now() + interval '1 day', gen_random_uuid())`,
          ),
        ),
      ];
    });

    // The state is refused by the guard before the check is reached: a request starts pending.
    expect(codes).toEqual([CHECK_VIOLATION, IMMUTABLE]);
  });

  it('ends declined or expired, with when, and then never changes again', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const declined = await insertConsentRequest(tx, a.id);
      await tx.execute(
        sql`UPDATE consent_request SET status = 'declined', closed_at = now() WHERE id = ${declined}`,
      );
      const expired = await insertConsentRequest(tx, a.id);
      await tx.execute(
        sql`UPDATE consent_request SET status = 'expired', closed_at = now() WHERE id = ${expired}`,
      );
      const reopen = await refusal(tx, (inner) =>
        inner.execute(
          sql`UPDATE consent_request SET status = 'pending', closed_at = null WHERE id = ${declined}`,
        ),
      );
      const reclose = await refusal(tx, (inner) =>
        inner.execute(
          sql`UPDATE consent_request SET status = 'expired', closed_at = now() WHERE id = ${declined}`,
        ),
      );
      return {
        reopen,
        reclose,
        states: [(await readRequest(tx, declined)).status, (await readRequest(tx, expired)).status],
      };
    });

    expect(result).toEqual({
      reopen: IMMUTABLE,
      reclose: IMMUTABLE,
      states: ['declined', 'expired'],
    });
  });

  it('cannot be marked signed or revoked by hand: only the rows beside it do that', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const id = await insertConsentRequest(tx, a.id);
      return [
        await refusal(tx, (inner) =>
          inner.execute(
            sql`UPDATE consent_request SET status = 'signed', signed_at = now() WHERE id = ${id}`,
          ),
        ),
        await refusal(tx, (inner) =>
          inner.execute(
            sql`UPDATE consent_request
                   SET status = 'revoked', signed_at = now(), revoked_at = now()
                 WHERE id = ${id}`,
          ),
        ),
      ];
    });

    expect(codes).toEqual([IMMUTABLE, IMMUTABLE]);
  });

  it('keeps who it is for, which version, how and until when', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const id = await insertConsentRequest(tx, a.id);
      const change = (assignment: ReturnType<typeof sql>) =>
        refusal(tx, (inner) =>
          inner.execute(sql`UPDATE consent_request SET ${assignment} WHERE id = ${id}`),
        );
      return [
        await change(sql`patient_id = ${await insertPatient(tx, a.id)}`),
        await change(sql`template_version_id = ${await insertConsentTemplateVersion(tx, a.id)}`),
        await change(sql`method = 'portal'`),
        await change(sql`expires_at = now() + interval '30 days'`),
        await change(sql`requested_by = gen_random_uuid()`),
      ];
    });

    expect(codes).toEqual([IMMUTABLE, IMMUTABLE, IMMUTABLE, IMMUTABLE, IMMUTABLE]);
  });

  it('allows one live request per patient and version, and a new one once the first ended', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const first = await insertConsentRequest(tx, a.id);
      const facts = await readRequest(tx, first);
      const again = () =>
        refusal(tx, (inner) =>
          inner.execute(
            sql`INSERT INTO consent_request
                  (tenant_id, patient_id, template_version_id, method, expires_at, requested_by)
                  VALUES (${a.id}, ${facts.patient_id}, ${facts.template_version_id}, 'in_person',
                          now() + interval '1 day', gen_random_uuid())`,
          ),
        );
      const whileWaiting = await again();
      await tx.execute(
        sql`UPDATE consent_request SET status = 'declined', closed_at = now() WHERE id = ${first}`,
      );
      return { whileWaiting, afterwards: await again() };
    });

    expect(codes).toEqual({ whileWaiting: UNIQUE_VIOLATION, afterwards: undefined });
  });

  it('is never deleted', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const id = await insertConsentRequest(tx, a.id);
      return refusal(tx, (inner) =>
        inner.execute(sql`DELETE FROM consent_request WHERE id = ${id}`),
      );
    });

    expect(code).toBe(NOT_ALLOWED);
  });
});

describe('consent_signature', () => {
  it('makes its request signed, with the time of the signature', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const signedAt = new Date('2031-03-01T15:00:00.000Z');
      const signed = await insertConsentSignature(tx, a.id, undefined, { signedAt });
      const request = await readRequest(tx, signed.requestId);
      return { request, signedAt };
    });

    expect(result.request.status).toBe('signed');
    expect(result.request.signed_at?.toISOString()).toBe(result.signedAt.toISOString());
    expect(result.request.revoked_at).toBeNull();
  });

  it('accepts one signature per request: a second one is refused', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const signed = await insertConsentSignature(tx, a.id);
      return refusal(tx, (inner) =>
        insertConsentSignature(inner, a.id, {
          request_id: signed.requestId,
          patient_id: signed.patientId,
          template_version_id: signed.versionId,
        }),
      );
    });

    expect(code).toBe(IMMUTABLE);
  });

  it('is refused for a request that is not pending, signed by nobody and ended', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const requestId = await insertConsentRequest(tx, a.id);
      const facts = await readRequest(tx, requestId);
      await tx.execute(
        sql`UPDATE consent_request SET status = 'expired', closed_at = now() WHERE id = ${requestId}`,
      );
      return refusal(tx, (inner) =>
        insertConsentSignature(inner, a.id, {
          request_id: requestId,
          patient_id: facts.patient_id,
          template_version_id: facts.template_version_id,
        }),
      );
    });

    expect(code).toBe(IMMUTABLE);
  });

  it('must match the patient and the version of its request', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const requestId = await insertConsentRequest(tx, a.id);
      const facts = await readRequest(tx, requestId);
      return [
        await refusal(tx, (inner) =>
          insertConsentSignature(inner, a.id, {
            request_id: requestId,
            patient_id: facts.patient_id,
            template_version_id: '0197c0a0-0000-7000-8000-0000000000aa',
          }),
        ),
        await refusal(tx, async (inner) =>
          insertConsentSignature(inner, a.id, {
            request_id: requestId,
            patient_id: await insertPatient(inner, a.id),
            template_version_id: facts.template_version_id,
          }),
        ),
        await refusal(tx, async (inner) =>
          insertConsentSignature(inner, a.id, {
            request_id: requestId,
            patient_id: facts.patient_id,
            template_version_id: await insertConsentTemplateVersion(inner, a.id),
          }),
        ),
      ];
    });

    expect(codes).toEqual([MISSING_PARENT, MISSING_PARENT, MISSING_PARENT]);
  });

  it('needs the acceptance of the signer', async () => {
    const code = await asTenant(runtime, a.id, (tx) =>
      refusal(tx, (inner) => insertConsentSignature(inner, a.id, undefined, { accepted: false })),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it('is recorded by a staff user when in person and by a portal identity when from the portal', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const signed = async (method: 'in_person' | 'portal') => {
        const requestId = await insertConsentRequest(tx, a.id, undefined, { method });
        const facts = await readRequest(tx, requestId);
        return { requestId, facts };
      };
      const insertAs = async (
        method: 'in_person' | 'portal',
        recordedBy: string | null,
        identity: string | null,
      ) => {
        const { requestId, facts } = await signed(method);
        return refusal(tx, (inner) =>
          inner.execute(
            sql`INSERT INTO consent_signature
                  (tenant_id, request_id, patient_id, template_version_id, signer_kind, accepted,
                   method, payload_enc, content_fingerprint, signed_at, recorded_by, portal_identity_id)
                  VALUES (${a.id}, ${requestId}, ${facts.patient_id}, ${facts.template_version_id},
                          'patient', true, ${method}, ${Buffer.from('x')}, ${'b'.repeat(64)}, now(),
                          ${recordedBy}, ${identity})`,
          ),
        );
      };
      return [
        await insertAs('in_person', randomUUID(), null),
        await insertAs('portal', null, randomUUID()),
        await insertAs('in_person', null, randomUUID()),
        await insertAs('portal', randomUUID(), null),
        await insertAs('portal', null, null),
      ];
    });

    expect(codes).toEqual([
      undefined,
      undefined,
      CHECK_VIOLATION,
      CHECK_VIOLATION,
      CHECK_VIOLATION,
    ]);
  });

  it('cannot be updated or deleted by the runtime role: the privilege is gone', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await insertConsentSignature(tx, a.id);
      return [
        await refusal(tx, (inner) =>
          inner.execute(sql`UPDATE consent_signature SET accepted = true WHERE id = ${id}`),
        ),
        await refusal(tx, (inner) =>
          inner.execute(sql`DELETE FROM consent_signature WHERE id = ${id}`),
        ),
      ];
    });

    expect(codes).toEqual([NOT_ALLOWED, NOT_ALLOWED]);
  });

  it('cannot be changed by the migration owner either: a trigger refuses', async () => {
    const { id, patientId } = await asTenant(runtime, a.id, (tx) =>
      insertConsentSignature(tx, a.id),
    );

    // The owner is bound by row level security too: it sees the row as the portal of the patient does.
    const codes = await asOwner(
      [
        `UPDATE consent_signature SET content_fingerprint = '${'c'.repeat(64)}' WHERE id = '${id}'`,
        `DELETE FROM consent_signature WHERE id = '${id}'`,
      ],
      { 'app.consent_portal_patient': patientId },
    );

    expect(codes).toEqual([IMMUTABLE, IMMUTABLE]);
  });

  it('is read by the professional who treats the patient, and by nobody else', async () => {
    const world = await asTenant(runtime, a.id, async (tx) => {
      const signed = await insertConsentSignature(tx, a.id);
      const treating = await insertProfessional(tx, a.id);
      const colleague = await insertProfessional(tx, a.id);
      await tx.execute(
        sql`INSERT INTO care_assignment (tenant_id, patient_id, professional_id, assigned_by)
              VALUES (${a.id}, ${signed.patientId}, ${treating}, gen_random_uuid())`,
      );
      return { ...signed, treating, colleague };
    });
    const count = (tx: Tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM consent_signature WHERE id = ${world.id}`,
      );

    const reception = (await asTenant(runtime, a.id, count)).rows[0]?.n;
    const treating = (await asProfessional(world.treating, count)).rows[0]?.n;
    const colleague = (await asProfessional(world.colleague, count)).rows[0]?.n;

    expect({ reception, treating, colleague }).toEqual({ reception: 0, treating: 1, colleague: 0 });
  });

  it('is read by the portal of the patient it belongs to, for that patient alone', async () => {
    const world = await asTenant(runtime, a.id, async (tx) => ({
      mine: await insertConsentSignature(tx, a.id),
      theirs: await insertConsentSignature(tx, a.id),
    }));

    const visible = await asTenant(runtime, a.id, async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.consent_portal_patient', ${world.mine.patientId}, true)`,
      );
      const rows = await tx.execute<{ id: string }>(
        sql`SELECT id FROM consent_signature WHERE id IN (${world.mine.id}, ${world.theirs.id})`,
      );
      return rows.rows.map((row) => row.id);
    });

    expect(visible).toEqual([world.mine.id]);
  });

  it('is written by a transaction that is not a professional (the device at reception)', async () => {
    const id = await asTenant(
      runtime,
      a.id,
      async (tx) => (await insertConsentSignature(tx, a.id)).id,
    );

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('consent_revocation', () => {
  it('is a new row that makes its request revoked, beside a signature that stays as it was', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const signed = await insertConsentSignature(tx, a.id);
      const before = (await readRequest(tx, signed.requestId)).signed_at;
      await insertConsentRevocation(tx, a.id, {
        request_id: signed.requestId,
        patient_id: signed.patientId,
      });
      const request = await readRequest(tx, signed.requestId);
      return { before, request };
    });

    expect(result.request.status).toBe('revoked');
    expect(result.request.revoked_at).not.toBeNull();
    expect(result.request.signed_at?.toISOString()).toBe(result.before?.toISOString());
  });

  it('needs a signed request, and a request is revoked once', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const pending = await insertConsentRequest(tx, a.id);
      const facts = await readRequest(tx, pending);
      const onPending = await refusal(tx, (inner) =>
        insertConsentRevocation(inner, a.id, {
          request_id: pending,
          patient_id: facts.patient_id,
        }),
      );
      const signed = await insertConsentSignature(tx, a.id);
      const revoke = () =>
        refusal(tx, (inner) =>
          insertConsentRevocation(inner, a.id, {
            request_id: signed.requestId,
            patient_id: signed.patientId,
          }),
        );
      return { onPending, first: await revoke(), second: await revoke() };
    });

    expect(codes).toEqual({ onPending: IMMUTABLE, first: undefined, second: IMMUTABLE });
  });

  it('must be for the patient of its request', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const signed = await insertConsentSignature(tx, a.id);
      return refusal(tx, async (inner) =>
        insertConsentRevocation(inner, a.id, {
          request_id: signed.requestId,
          patient_id: await insertPatient(inner, a.id),
        }),
      );
    });

    expect(code).toBe(MISSING_PARENT);
  });

  it('follows its channel: a staff user in person, a portal identity from the portal', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const attempt = async (
        channel: string,
        actorUserId: string | null,
        portalIdentityId: string | null,
      ) => {
        const signed = await insertConsentSignature(tx, a.id);
        return refusal(tx, (inner) =>
          inner.execute(
            sql`INSERT INTO consent_revocation
                  (tenant_id, request_id, patient_id, channel, actor_user_id, portal_identity_id, revoked_at)
                  VALUES (${a.id}, ${signed.requestId}, ${signed.patientId}, ${channel},
                          ${actorUserId}, ${portalIdentityId}, now())`,
          ),
        );
      };
      return [
        await attempt('in_person', randomUUID(), null),
        await attempt('portal', null, randomUUID()),
        await attempt('portal', randomUUID(), null),
        await attempt('in_person', null, null),
      ];
    });

    expect(codes).toEqual([undefined, undefined, CHECK_VIOLATION, CHECK_VIOLATION]);
  });

  it('cannot be updated or deleted: not by the runtime role, not by the owner', async () => {
    const id = await asTenant(runtime, a.id, (tx) => insertConsentRevocation(tx, a.id));

    const runtimeCodes = await asTenant(runtime, a.id, async (tx) => [
      await refusal(tx, (inner) =>
        inner.execute(sql`UPDATE consent_revocation SET channel = 'portal' WHERE id = ${id}`),
      ),
      await refusal(tx, (inner) =>
        inner.execute(sql`DELETE FROM consent_revocation WHERE id = ${id}`),
      ),
    ]);
    const ownerCodes = await asOwner([
      `UPDATE consent_revocation SET channel = 'portal' WHERE id = '${id}'`,
      `DELETE FROM consent_revocation WHERE id = '${id}'`,
    ]);

    expect(runtimeCodes).toEqual([NOT_ALLOWED, NOT_ALLOWED]);
    expect(ownerCodes).toEqual([IMMUTABLE, IMMUTABLE]);
  });
});

describe('appointment_type.requires_consent_template_id', () => {
  it('points at a template of the same organization only', async () => {
    const other = await createTestTenant(runtime, { slug: 'consent-signing-schema-b' });
    const foreignTemplate = await asTenant(runtime, other.id, (tx) =>
      insertConsentTemplateVersion(tx, other.id).then(async (versionId) => {
        const rows = await tx.execute<{ template_id: string }>(
          sql`SELECT template_id FROM consent_template_version WHERE id = ${versionId}`,
        );
        return rows.rows[0]?.template_id ?? '';
      }),
    );

    const codes = await asTenant(runtime, a.id, async (tx) => {
      const own = (
        await tx.execute<{ template_id: string }>(
          sql`SELECT template_id FROM consent_template_version
               WHERE id = ${await insertConsentTemplateVersion(tx, a.id)}`,
        )
      ).rows[0]?.template_id;
      const typeId = (
        await tx.execute<{ id: string }>(
          sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes)
                VALUES (${a.id}, 'Extraccion', 30) RETURNING id`,
        )
      ).rows[0]?.id;
      return [
        await refusal(tx, (inner) =>
          inner.execute(
            sql`UPDATE appointment_type SET requires_consent_template_id = ${own} WHERE id = ${typeId}`,
          ),
        ),
        await refusal(tx, (inner) =>
          inner.execute(
            sql`UPDATE appointment_type SET requires_consent_template_id = ${foreignTemplate}
                 WHERE id = ${typeId}`,
          ),
        ),
      ];
    });

    expect(codes).toEqual([undefined, MISSING_PARENT]);
  });
});
