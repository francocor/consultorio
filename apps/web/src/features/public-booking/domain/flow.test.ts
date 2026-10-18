import type { PublicConfirmationDto, PublicHoldDto, PublicSlotDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { flowReducer, initialFlow, type FlowState } from './flow.js';

const slot: PublicSlotDto = {
  startsAt: '2031-05-12T13:00:00.000Z',
  endsAt: '2031-05-12T13:30:00.000Z',
  locationId: '0190a000-0000-7000-8000-000000000001',
  date: '2031-05-12',
};
const hold: PublicHoldDto = {
  id: '0190a000-0000-7000-8000-000000000002',
  startsAt: slot.startsAt,
  endsAt: slot.endsAt,
  expiresAt: '2031-05-12T13:10:00.000Z',
  locationId: slot.locationId,
  appointmentTypeId: '0190a000-0000-7000-8000-000000000003',
};
const confirmation: PublicConfirmationDto = {
  status: 'scheduled',
  startsAt: slot.startsAt,
  endsAt: slot.endsAt,
  timeZone: 'America/Argentina/Buenos_Aires',
  organizationName: 'Aillu',
  professionalName: 'Dra. Pérez',
  locationName: 'Centro',
  typeName: 'Consulta',
  mode: 'in_person',
  calendarFile: 'BEGIN:VCALENDAR',
  managePath: '/book/manage/abc',
};

const held: FlowState = flowReducer(
  flowReducer(initialFlow('pro-1'), { type: 'pick', typeId: 't1', locationId: 'l1' }),
  { type: 'held', slot, hold },
);

describe('the booking flow', () => {
  it('starts on the choice of time for the professional it was opened for', () => {
    expect(initialFlow('pro-1')).toMatchObject({
      step: 'choose',
      professionalSlug: 'pro-1',
      typeId: null,
      locationId: null,
      slot: null,
      hold: null,
      notice: null,
    });
  });

  it('can start without a professional, on the organization page', () => {
    expect(initialFlow(null).professionalSlug).toBeNull();
  });

  it('remembers the type and place that were chosen', () => {
    const next = flowReducer(initialFlow('pro-1'), {
      type: 'pick',
      typeId: 't1',
      locationId: 'l1',
    });

    expect(next).toMatchObject({ typeId: 't1', locationId: 'l1', step: 'choose' });
  });

  it('moves to the form once a slot is held', () => {
    expect(held).toMatchObject({ step: 'details', slot, hold, notice: null });
  });

  it('moves to the code once the form is accepted, and keeps the hidden address to show', () => {
    const next = flowReducer(held, { type: 'submitted', maskedEmail: 'l***@example.test' });

    expect(next).toMatchObject({ step: 'code', maskedEmail: 'l***@example.test', hold });
  });

  it('ends on the confirmation, which is the same screen whoever the patient is', () => {
    const next = flowReducer(
      flowReducer(held, { type: 'submitted', maskedEmail: 'l***@example.test' }),
      { type: 'confirmed', confirmation },
    );

    expect(next).toMatchObject({ step: 'done', confirmation });
  });

  it('goes back from the code to the form, keeping the hold', () => {
    const atCode = flowReducer(held, { type: 'submitted', maskedEmail: 'x' });

    expect(flowReducer(atCode, { type: 'back' })).toMatchObject({ step: 'details', hold });
  });

  it('goes back from the form to the choice of time, giving the hold up', () => {
    const next = flowReducer(held, { type: 'back' });

    expect(next).toMatchObject({ step: 'choose', hold: null, slot: null });
  });

  it('returns to the choice of time with a notice when the slot is lost', () => {
    expect(flowReducer(held, { type: 'lost', reason: 'slot_taken' })).toMatchObject({
      step: 'choose',
      hold: null,
      slot: null,
      notice: 'slot_taken',
    });
    expect(flowReducer(held, { type: 'lost', reason: 'hold_expired' }).notice).toBe('hold_expired');
  });

  it('clears the notice when the visitor acts again', () => {
    const lost = flowReducer(held, { type: 'lost', reason: 'slot_taken' });

    expect(flowReducer(lost, { type: 'dismissNotice' }).notice).toBeNull();
    expect(flowReducer(lost, { type: 'pick', typeId: 't1', locationId: 'l1' }).notice).toBeNull();
  });

  it('changes the professional from the organization page, forgetting what depended on it', () => {
    const next = flowReducer(held, { type: 'professional', slug: 'pro-2' });

    expect(next).toMatchObject({
      professionalSlug: 'pro-2',
      typeId: null,
      locationId: null,
      slot: null,
      hold: null,
      step: 'choose',
    });
  });

  it('ignores an event that does not belong to the step it is on', () => {
    const idle = initialFlow('pro-1');

    expect(flowReducer(idle, { type: 'submitted', maskedEmail: 'x' })).toBe(idle);
    expect(flowReducer(idle, { type: 'confirmed', confirmation })).toBe(idle);
    expect(flowReducer(idle, { type: 'back' })).toBe(idle);
  });
});
