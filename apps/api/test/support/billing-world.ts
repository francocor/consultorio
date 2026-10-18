import type { AppointmentDto } from '@consultorio/contracts';
import pg from 'pg';
import { expect, inject } from 'vitest';

import type { DbHandle } from '../../src/platform/db/pool.js';

import {
  createSchedulingHttpWorld,
  type Doctor,
  type SchedulingHttpWorld,
} from './scheduling-world.js';

/** What state an appointment is taken to before a charge is captured for it. */
export type AppointmentStage =
  'scheduled' | 'confirmed' | 'checked_in' | 'in_progress' | 'attended' | 'no_show' | 'cancelled';

export interface BillingWorld extends SchedulingHttpWorld {
  /** A payer of the platform catalog (Argentina), written on the owner connection. */
  catalogPayer(
    code: string,
    name: string,
    kind?: 'obra_social' | 'prepaga' | 'private',
  ): Promise<string>;
  /**
   * A new appointment of a new patient (or `patientId`) with `doctor` (or `professional`) at Centro,
   * on a slot of its own, taken to `stage` the way reception and the doctor do. Defaults to checked in.
   */
  appointment(options?: {
    stage?: AppointmentStage;
    patientId?: string;
    professional?: Doctor;
    typeId?: string;
  }): Promise<AppointmentDto>;
  /**
   * Covers a patient with a payer of the platform catalog (or a custom one) and a plan, the way
   * reception does: it enables the payer plan of the organization once, then adds the coverage.
   */
  cover(
    patientId: string,
    options: { payerId?: string; customName?: string; planName?: string; validTo?: string },
  ): Promise<{ payerPlanId: string }>;
  /** Owner creates a price for the Consulta type (or `typeId`) and expects 201. */
  setPrice(amountCents: number, extra?: Record<string, unknown>): Promise<{ id: string }>;
}

const TIMES = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'] as const;

/**
 * The scheduling world with what the billing tests need on top: appointments at every stage of the
 * attendance, payers in the platform catalog and prices. One world per test file.
 */
export async function createBillingWorld(
  runtime: DbHandle,
  options: { slug: string; app?: Parameters<typeof createSchedulingHttpWorld>[1]['app'] },
): Promise<BillingWorld> {
  const base = await createSchedulingHttpWorld(runtime, {
    slug: options.slug,
    ...(options.app ? { app: options.app } : {}),
  });
  const used = new Map<string, number>();

  const catalogPayer: BillingWorld['catalogPayer'] = async (code, name, kind = 'obra_social') => {
    const owner = new pg.Client({ connectionString: inject('ownerUrl') });
    await owner.connect();
    try {
      const result = await owner.query<{ id: string }>(
        `insert into payer (country, code, name, kind) values ('AR', $1, $2, $3)
         on conflict (country, code) do update set name = excluded.name returning id`,
        [code, name, kind],
      );
      return result.rows[0]?.id ?? '';
    } finally {
      await owner.end();
    }
  };

  const appointment: BillingWorld['appointment'] = async (settings = {}) => {
    const professional = settings.professional ?? base.doctor;
    const index = used.get(professional.professionalId) ?? 0;
    used.set(professional.professionalId, index + 1);
    const week = 1 + Math.floor(index / TIMES.length);
    const time = TIMES[index % TIMES.length] ?? '09:00';
    const created = await base.book(week, time, {
      professionalId: professional.professionalId,
      ...(settings.patientId ? { patientId: settings.patientId } : {}),
      ...(settings.typeId ? { appointmentTypeId: settings.typeId } : {}),
    });

    const stage = settings.stage ?? 'checked_in';
    const step = async (
      action: string,
      by: typeof base.reception,
      body: Record<string, unknown> = {},
    ) => {
      const response = await base.act(created, action, by, body);
      expect(response.statusCode, `${action}: ${response.body}`).toBe(200);
    };
    if (stage === 'confirmed') await step('confirm', base.reception);
    if (stage === 'checked_in' || stage === 'in_progress' || stage === 'attended') {
      await step('check-in', base.reception);
    }
    if (stage === 'in_progress' || stage === 'attended') await step('start', professional);
    if (stage === 'attended') await step('attend', professional);
    if (stage === 'no_show') await step('no-show', base.reception);
    if (stage === 'cancelled') {
      await step('cancel', base.reception, { cancelledBy: 'patient', reasonCode: 'illness' });
    }
    return created;
  };

  const plans = new Map<string, string>();
  const cover: BillingWorld['cover'] = async (patientId, settings) => {
    const key = `${settings.payerId ?? settings.customName ?? ''}|${settings.planName ?? ''}`;
    let payerPlanId = plans.get(key);
    if (!payerPlanId) {
      const created = await base.api.post('/payer-plans', base.reception, {
        ...(settings.payerId ? { payerId: settings.payerId } : { customName: settings.customName }),
        ...(settings.planName ? { planName: settings.planName } : {}),
      });
      expect(created.statusCode, created.body).toBe(201);
      payerPlanId = created.json<{ id: string }>().id;
      plans.set(key, payerPlanId);
    }
    const added = await base.api.post(`/patients/${patientId}/coverages`, base.reception, {
      payerPlanId,
      memberNumber: '123456',
      primary: true,
      ...(settings.validTo ? { validTo: settings.validTo } : {}),
    });
    expect(added.statusCode, added.body).toBe(201);
    return { payerPlanId };
  };

  return {
    ...base,
    catalogPayer,
    cover,
    appointment,
    setPrice: async (amountCents, extra = {}) => {
      const response = await base.api.post('/billing/prices', base.owner, {
        appointmentTypeId: base.consulta,
        amountCents,
        effectiveFrom: '2031-01-01',
        ...extra,
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ id: string }>();
    },
  };
}
