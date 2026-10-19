import { randomUUID } from 'node:crypto';

import type { PatientPortalResponse, PortalIdentityDto } from '@consultorio/contracts';
import { type sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

import type { patient } from '../../src/db/schema/patients.js';

import { createBookingWorld, type BookingWorld, type Visitor } from './booking-world.js';
import { createTestPatient } from './patients.js';
import type { TestSession } from './session.js';

/**
 * The world of the portal tests: the organization of the booking tests (owner, admin, reception,
 * two professionals, public visitors with their cookies, the fake email and the recording job
 * client) plus the portal's own helpers. The application is the one `main` builds, with the portal
 * wired the way production wires it.
 */
export interface PortalWorld extends BookingWorld {
  /** A patient of the organization, written straight to the database. */
  patientWith(values?: Partial<typeof patient.$inferInsert>): Promise<string>;
  /** Staff invite a patient (default: reception). */
  invite(
    patientId: string,
    body?: Record<string, unknown>,
    by?: TestSession,
  ): Promise<LightMyRequestResponse>;
  /** Invites and expects 201. */
  inviteOk(
    patientId: string,
    body?: Record<string, unknown>,
    by?: TestSession,
  ): Promise<PortalIdentityDto>;
  /** The path of the link in the last email sent to `address` (`/public/t/<token>`). */
  activationPathSentTo(address: string): string;
  /** Follows an activation link as a visitor: shows the page, then presses its button. */
  activate(
    path: string,
    visitor?: Visitor,
  ): Promise<{ page: LightMyRequestResponse; done: LightMyRequestResponse }>;
  /** Invites, follows the link and returns the active identity. */
  onboard(patientId: string, body?: Record<string, unknown>): Promise<PortalIdentityDto>;
  /** What the staff screen of a patient shows. */
  portalOf(patientId: string, by?: TestSession): Promise<PatientPortalResponse>;
}

let patients = 0;

export async function createPortalWorld(
  runtime: Parameters<typeof createBookingWorld>[0],
  options: { slug: string; now?: Date },
): Promise<PortalWorld> {
  const base = await createBookingWorld(runtime, options);
  const patientWith: PortalWorld['patientWith'] = (values = {}) => {
    patients += 1;
    return createTestPatient(runtime, base.tenant.id, {
      familyName: `Portal${String(patients)}`,
      givenNames: 'Paciente',
      nationalIdType: 'dni',
      nationalId: String(40_000_000 + patients),
      birthDate: '1985-03-10',
      email: `paciente${String(patients)}-${randomUUID().slice(0, 6)}@example.test`,
      ...values,
    });
  };

  const invite: PortalWorld['invite'] = (patientId, body = {}, by = base.reception) =>
    base.api.post(`/patients/${patientId}/portal-invitation`, by, body);

  const inviteOk: PortalWorld['inviteOk'] = async (patientId, body, by) => {
    const response = await invite(patientId, body, by);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ identity: PortalIdentityDto }>().identity;
  };

  const activationPathSentTo: PortalWorld['activationPathSentTo'] = (address) => {
    const link = base.email.linkIn(base.email.lastTo(address));
    if (!link) throw new Error(`no link was sent to ${address}`);
    return new URL(link).pathname;
  };

  const activate: PortalWorld['activate'] = async (path, who = base.visitor()) => {
    const page = await who.get(path);
    const done = await who.post(path, {});
    return { page, done };
  };

  return {
    ...base,
    patientWith,
    invite,
    inviteOk,
    activationPathSentTo,
    activate,
    onboard: async (patientId, body) => {
      const identity = await inviteOk(patientId, body);
      const { done } = await activate(activationPathSentTo(identity.email));
      expect(done.statusCode, done.body).toBe(200);
      const shown = await base.api.get(`/patients/${patientId}/portal`, base.reception);
      const found = shown
        .json<PatientPortalResponse>()
        .identities.find((candidate) => candidate.id === identity.id);
      if (!found) throw new Error('the activated identity is not listed');
      return found;
    },
    portalOf: async (patientId, by = base.reception) => {
      const response = await base.api.get(`/patients/${patientId}/portal`, by);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<PatientPortalResponse>();
    },
  };
}

/** Runs SQL as the organization and returns the rows. */
export async function rowsOf<T extends Record<string, unknown>>(
  world: Pick<BookingWorld, 'inTenant'>,
  statement: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = await world.inTenant((tx) => tx.execute(statement));
  return result.rows as T[];
}
