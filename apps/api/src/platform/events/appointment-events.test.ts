import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '../db/tenant-context.js';

import {
  createAppointmentEvents,
  type AppointmentEvent,
  type AppointmentFacts,
} from './appointment-events.js';

const tx = { id: 'the-transaction' } as unknown as Tx;

const facts: AppointmentFacts = {
  appointmentId: 'appt-1',
  patientId: 'patient-1',
  professionalId: 'doctor-1',
  locationId: 'centro',
  appointmentTypeId: 'type-30',
  startsAt: new Date('2031-01-06T13:00:00.000Z'),
  endsAt: new Date('2031-01-06T13:30:00.000Z'),
  status: 'scheduled',
  source: 'staff',
  version: 1,
};

const created: AppointmentEvent = { kind: 'created', tenantId: 'tenant-1', appointment: facts };

describe('appointment events', () => {
  it('hands every subscriber the event and the transaction of the business write, in order', async () => {
    const events = createAppointmentEvents();
    const calls: string[] = [];
    events.subscribe((received, event) => {
      calls.push(`first:${event.kind}:${(received as unknown as { id: string }).id}`);
      return Promise.resolve();
    });
    events.subscribe(async (_received, event) => {
      await Promise.resolve();
      calls.push(`second:${event.kind}`);
    });

    await events.publish(tx, created);

    expect(calls).toEqual(['first:created:the-transaction', 'second:created']);
  });

  it('waits for each subscriber before the next one runs', async () => {
    const events = createAppointmentEvents();
    const order: string[] = [];
    events.subscribe(async () => {
      order.push('slow:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow:end');
    });
    events.subscribe(() => {
      order.push('fast');
      return Promise.resolve();
    });

    await events.publish(tx, created);

    expect(order).toEqual(['slow:start', 'slow:end', 'fast']);
  });

  it('lets a failing subscriber fail the publish, so the business write rolls back with it', async () => {
    const events = createAppointmentEvents();
    const after = vi.fn(() => Promise.resolve());
    events.subscribe(() => Promise.reject(new Error('reminder planner is down')));
    events.subscribe(after);

    await expect(events.publish(tx, created)).rejects.toThrow('reminder planner is down');
    expect(after).not.toHaveBeenCalled();
  });

  it('stops calling a subscriber that unsubscribed, and keeps the others', async () => {
    const events = createAppointmentEvents();
    const kept = vi.fn(() => Promise.resolve());
    const dropped = vi.fn(() => Promise.resolve());
    events.subscribe(kept);
    const unsubscribe = events.subscribe(dropped);

    unsubscribe();
    await events.publish(tx, created);

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('keeps one bus apart from another, so two applications in one process never share subscribers', async () => {
    const one = createAppointmentEvents();
    const other = createAppointmentEvents();
    const heard = vi.fn(() => Promise.resolve());
    one.subscribe(heard);

    await other.publish(tx, created);

    expect(heard).not.toHaveBeenCalled();
  });

  it('is a no-op without subscribers', async () => {
    await expect(createAppointmentEvents().publish(tx, created)).resolves.toBeUndefined();
  });
});
