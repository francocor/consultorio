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
  /** Creates (or reserves) the room named by the opaque id. Idempotent for the same id. */
  createRoom(opaqueId: string): Promise<VideoRoom>;
  /** The address that opens the room. Only the platform join route reveals it, inside the window. */
  joinUrl(room: string): string;
}
