import type { PublicConfirmationDto, PublicHoldDto, PublicSlotDto } from '@consultorio/contracts';

/** The steps of a booking, in order. The visitor sees one at a time. */
export type FlowStep = 'choose' | 'details' | 'code' | 'done';

/** Why the visitor was sent back to the choice of time. */
export type FlowNotice = 'slot_taken' | 'hold_expired';

export interface FlowState {
  step: FlowStep;
  professionalSlug: string | null;
  typeId: string | null;
  locationId: string | null;
  slot: PublicSlotDto | null;
  hold: PublicHoldDto | null;
  /** The address the code went to, hidden in part. */
  maskedEmail: string | null;
  confirmation: PublicConfirmationDto | null;
  notice: FlowNotice | null;
}

export type FlowEvent =
  | { type: 'professional'; slug: string | null }
  | { type: 'pick'; typeId: string; locationId: string }
  | { type: 'held'; slot: PublicSlotDto; hold: PublicHoldDto }
  | { type: 'submitted'; maskedEmail: string }
  | { type: 'confirmed'; confirmation: PublicConfirmationDto }
  | { type: 'back' }
  | { type: 'lost'; reason: FlowNotice }
  | { type: 'dismissNotice' };

export function initialFlow(professionalSlug: string | null): FlowState {
  return {
    step: 'choose',
    professionalSlug,
    typeId: null,
    locationId: null,
    slot: null,
    hold: null,
    maskedEmail: null,
    confirmation: null,
    notice: null,
  };
}

/**
 * What the booking page is doing, as a pure function of what the visitor did. An event that makes
 * no sense for the step the visitor is on changes nothing, so a late answer of the network (a code
 * confirmed after they went back) cannot move them somewhere unexpected.
 */
export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'professional':
      return {
        ...initialFlow(event.slug),
        notice: null,
      };
    case 'pick':
      return state.step === 'choose'
        ? { ...state, typeId: event.typeId, locationId: event.locationId, notice: null }
        : state;
    case 'held':
      return state.step === 'choose'
        ? { ...state, step: 'details', slot: event.slot, hold: event.hold, notice: null }
        : state;
    case 'submitted':
      return state.step === 'details'
        ? { ...state, step: 'code', maskedEmail: event.maskedEmail }
        : state;
    case 'confirmed':
      return state.step === 'code'
        ? { ...state, step: 'done', confirmation: event.confirmation }
        : state;
    case 'back':
      if (state.step === 'code') return { ...state, step: 'details' };
      if (state.step === 'details') {
        return { ...state, step: 'choose', slot: null, hold: null, maskedEmail: null };
      }
      return state;
    case 'lost':
      return state.step === 'done'
        ? state
        : {
            ...state,
            step: 'choose',
            slot: null,
            hold: null,
            maskedEmail: null,
            notice: event.reason,
          };
    case 'dismissNotice':
      return { ...state, notice: null };
  }
}
