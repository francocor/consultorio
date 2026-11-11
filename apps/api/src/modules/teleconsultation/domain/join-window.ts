import { VIDEO_JOIN_CLOSES_AFTER_END_MINUTES } from '@consultorio/contracts';

const MINUTE_MS = 60_000;

export interface JoinWindow {
  opensAt: Date;
  closesAt: Date;
}

export type WindowState = 'early' | 'open' | 'closed';

/**
 * When a virtual appointment can be joined: from `joinOpensMinutes` (the organization's setting,
 * 15 by default) before the start until 60 minutes after the scheduled end, so a consultation that
 * runs long keeps its link (teleconsultation, "Link access and validity").
 */
export function joinWindowOf(
  appointment: { startsAt: Date; endsAt: Date },
  joinOpensMinutes: number,
): JoinWindow {
  return {
    opensAt: new Date(appointment.startsAt.getTime() - joinOpensMinutes * MINUTE_MS),
    closesAt: new Date(
      appointment.endsAt.getTime() + VIDEO_JOIN_CLOSES_AFTER_END_MINUTES * MINUTE_MS,
    ),
  };
}

/** Both ends belong to the window. */
export function windowStateAt(window: JoinWindow, now: Date): WindowState {
  if (now.getTime() < window.opensAt.getTime()) return 'early';
  if (now.getTime() > window.closesAt.getTime()) return 'closed';
  return 'open';
}

/** A no-show on a virtual appointment waits this long after the start (`noShowAfterMinutes`). */
export function noShowAllowedFrom(startsAt: Date, noShowAfterMinutes: number): Date {
  return new Date(startsAt.getTime() + noShowAfterMinutes * MINUTE_MS);
}
