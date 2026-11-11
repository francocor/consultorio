import { randomBytes } from 'node:crypto';

/**
 * Port of the teleconsultation module. A virtual appointment gets a room at a video provider; which
 * provider is an adapter (`adapters/video-*`): Jitsi as a Service in production, a public Jitsi
 * server while the owner has no account, a static address for tests and demo organizations.
 *
 * The room name is an opaque random identifier. The provider never receives a patient's name, the
 * professional's name or anything about the appointment.
 */

export interface VideoRoom {
  /** The opaque room name the provider knows, stored in `appointment.video_room`. */
  room: string;
}

export interface VideoLinkProvider {
  /** The adapter's own name (`local`, `fake`), kept on the video session. */
  readonly name: string;
  /**
   * The host names a manual link may point at (`VIDEO_ALLOWED_DOMAINS`). The platform setting
   * reaches the module through the adapter, so it is the same whether the provider works or not.
   */
  readonly manualLinkDomains: readonly string[];
  /** Creates (or reserves) the room named by the opaque id. Idempotent for the same id. */
  createRoom(opaqueId: string): Promise<VideoRoom>;
  /** The address that opens the room. Only the platform join route reveals it, inside the window. */
  joinUrl(room: string): string;
}

/** 128 random bits in lower-case hexadecimal: the only kind of name a provider ever receives. */
const OPAQUE_ROOM_ID = /^[a-f0-9]{32}$/;

export function isOpaqueRoomId(value: string): boolean {
  return OPAQUE_ROOM_ID.test(value);
}

export function newOpaqueRoomId(): string {
  return randomBytes(16).toString('hex');
}

/** A provider refuses any other name, so personal data cannot reach it by a mistake of a caller. */
export class InvalidRoomNameError extends Error {
  constructor() {
    super('A video room name must be an opaque identifier of 128 random bits.');
    this.name = 'InvalidRoomNameError';
  }
}

/** The provider cannot be asked: it is not configured, or it is switched off for the platform. */
export class VideoProviderUnavailableError extends Error {
  constructor() {
    super('The video provider is not available.');
    this.name = 'VideoProviderUnavailableError';
  }
}
